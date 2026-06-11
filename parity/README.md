# Modal ↔ K8s Parity Harness

Shadow-traffic parity check for the Modal → K8s migration (phase 1.1 bake).
Compares `/availability/slots` responses between the Modal-backed reference
backend and the K8s-native backend, classifies divergence into `OK` / `WARN` /
`CRITICAL` buckets, and emits one NDJSON record per (service, date) probe.

The harness is intended to run from a tailnet-reachable host (cron or Ansible
managed). It never exposes either backend publicly and requires the same HMAC
shared secret the middleware uses for upstream auth.

## Purpose

During phase 1.1 of the Modal → K8s migration, the K8s cluster serves *shadow*
traffic only: real reads are replayed against it for correctness comparison
while Modal remains the reference path. K8s-native middleware execution is the
target production route after parity bake passes. This harness drives that
comparison on a fixed cadence (nightly or every 10 minutes during active bake)
so divergence can be surfaced via Loki alerts long before any cutover.

## Environment variables

| Variable                 | Required | Default | Purpose                                                                          |
| ------------------------ | -------- | ------- | -------------------------------------------------------------------------------- |
| `MODAL_URL`              | yes      | —       | Base URL of the Modal deployment (tailnet-reachable).                            |
| `K8S_URL`                | yes      | —       | Base URL of the K8s shadow deployment (tailnet-reachable).                       |
| `ACUITY_MW_AUTH_TOKEN`   | yes      | —       | Bearer token the middleware server requires (`AUTH_TOKEN` on the server side).   |
| `ACUITY_MW_HMAC_SECRET`  | yes      | —       | Shared HMAC secret for replay-protection signing (`HMAC_SECRET` legacy alias).   |
| `SERVICE_IDS`            | yes      | —       | Comma-separated Acuity service IDs to probe.                                     |
| `DATE_HORIZON`           | no       | `14`    | Probe days 0..N into the future (inclusive), per service.                        |

### Auth model

Every request to both backends sends **two** auth mechanisms:

1. **Bearer token** (`Authorization: Bearer <ACUITY_MW_AUTH_TOKEN>`) — the
   mechanism the middleware server actually enforces. Requests without a valid
   `AUTH_TOKEN` header are rejected 401.
2. **HMAC headers** (`X-Timestamp` + `X-Signature`) — replay-protection
   signing for future tightening. The server currently logs these but does not
   enforce them; they are included now so the infrastructure is in place before
   enforcement is added.

The HMAC signature is `HMAC-SHA256(secret, timestamp + path + bodyHash)` where
`timestamp` is the Unix epoch in milliseconds, `path` is the request path, and
`bodyHash` is the SHA-256 hex digest of the raw JSON request body. Bodyless GETs
use the SHA-256 digest of the empty string. The current slot probe posts to
`/availability/slots` with a JSON body:

```json
{"serviceId":"12345","date":"2026-05-01"}
```

Both `MODAL_URL` and `K8S_URL` must be tailnet-reachable from the harness host.
The harness never punches out to the public internet — it relies on the same
private routing the middleware itself uses.

## Slot Contract

Current bridge responses wrap available slots in the standard success envelope:

```json
{"success":true,"data":[{"datetime":"2026-05-01T10:00:00Z","available":true}]}
```

The harness also accepts the legacy raw `{ "slots": [...] }` shape so old
captures can still be replayed during investigation. Slot identity is taken
from `datetime`, with `start_iso` and `startIso` tolerated for historical
fixtures. Slots marked `"available": false` are ignored for drift counts.
Disabled Acuity calendar dates are a valid zero-slot result and should not be
reported as scrape failures.

## Exit codes

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| `0`  | All probes returned `OK` or `WARN`. Nothing to alert on.           |
| `2`  | At least one probe returned `CRITICAL`. Cron should alert.         |
| `1`  | Unexpected runtime error (missing env var, TypeScript crash, …).   |

Cron should treat `exit != 0` as page-worthy; `exit == 2` specifically is the
signal that Modal/K8s have meaningfully diverged for at least one slot probe.

## Suggested cadence

During phase 1.1 bake, run every **10 minutes** via cron from a tailnet host.
Pipe stdout to a journal file and forward to Loki so `level=CRITICAL` lines
can drive an alert.

Example crontab line:

```
*/10 * * * *  cd /opt/parity && tsx parity/check.ts >> /var/log/parity.ndjson 2>&1
```

Once bake is complete (≥ 7 consecutive days with zero `CRITICAL`), drop the
cadence to hourly or nightly before promoting K8s to receive real traffic.

## Diff thresholds

The classifier bins the symmetric-difference count of available slot timestamps:

| Drift (slots) | Level      | Action                                                    |
| ------------- | ---------- | --------------------------------------------------------- |
| `≤ 2`         | `OK`       | Normal TTL skew — no action.                              |
| `3..5`        | `WARN`     | Log but do not page; investigate if persistent.           |
| `> 5`         | `CRITICAL` | Page on-call; Modal ↔ K8s have meaningfully diverged.     |

### Why `2` for OK

The middleware caches slot reads with a **5-minute TTL**. At any TTL boundary
one backend may observe the next refresh a few seconds before the other, so a
single slot can legitimately appear in one response and not the other without
indicating a real divergence. Empirically two slots is a safe ceiling for
that natural edge — one can plausibly appear and another plausibly disappear
in the same boundary window. We chose `2` (rather than `1`) to absorb that
without generating false `WARN` noise.

If you tighten the TTL (e.g., to 60 s) you may be able to lower this to `1`
and still avoid false positives. If you loosen it, raise the threshold.

### Why `5` for WARN → CRITICAL

Beyond 5 slots of drift, the most common cause we have seen in manual testing
is a stale catalog or a dropped Acuity session on one side — i.e., exactly
the classes of bug this harness exists to surface. Keeping `CRITICAL` at
`> 5` keeps the alert quiet until the signal is unambiguous.

## Usage

Run directly from a tailnet host with environment variables set:

```bash
export MODAL_URL='https://modal.example-tailnet.internal'
export K8S_URL='https://k8s.example-tailnet.internal'
export ACUITY_MW_AUTH_TOKEN='...'
export ACUITY_MW_HMAC_SECRET='...'
export SERVICE_IDS='12345,67890'
export DATE_HORIZON=14

tsx parity/check.ts
```

Each probe emits one NDJSON line to stdout with structured fields:

```json
{"ts":"2026-04-17T06:30:00.000Z","service":"12345","date":"2026-05-01","modalCount":4,"k8sCount":4,"level":"OK","detail":"drift=0"}
{"ts":"2026-04-17T06:30:00.100Z","service":"12345","date":"2026-05-02","modalCount":5,"k8sCount":8,"level":"WARN","detail":"drift=3, onlyModal=2, onlyK8s=1"}
```

The `service` and `date` fields allow T22 rollup queries to aggregate by service
or date window without needing to parse the `detail` string.

## Structure

- `parity/check.ts` — library + CLI. Exports `classifyDiff`, `runParityCheck`,
  and the supporting types (`Slot`, `SlotsResponse`, `DiffLevel`, `DiffResult`,
  `ParityConfig`).
- `parity/check.test.ts` — Vitest suite covering the four classifier bands.
- CLI entry point is guarded with `import.meta.url === file://$0` so it is
  inert under `vitest` / library imports and active only when invoked directly
  via `tsx parity/check.ts` or `node parity/check.js`.

## Non-goals

- This harness does **not** probe booking, intake, or any write endpoint.
  Writes must never be shadowed to both backends concurrently.
- It does **not** own alerting. Loki / Alertmanager rules live in the Ansible
  deployment (see T21).
- It does **not** own the long-term paper dataset rollup — that is T22.
