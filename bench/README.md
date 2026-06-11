# Acuity Middleware — k6 Benchmarking Harness

Parity benchmarks for Modal vs Kubernetes deployments.
Results feed `paper/data/phase1/` for the migration paper.

## Prerequisites

### 1. Install k6

macOS:

```bash
brew install k6
```

Debian/Ubuntu:

```bash
sudo apt install k6
```

Other platforms: https://k6.io/docs/getting-started/installation/

### 2. Network access

Either:

**Option A — Tailnet (recommended for K8s target):**
The default `BASE_URL` resolves via MagicDNS. Verify your machine is on the
tailnet and the service is reachable:

```bash
tailscale status | grep ts-acuity-mw
curl http://ts-acuity-mw.ts.net:3001/services
```

**Option B — Direct URL (Modal or any reachable host):**
Pass `--base-url` equivalent by setting `BASE_URL` in your environment:

```bash
BASE_URL=https://your-modal-endpoint.modal.run TARGET=modal ./run.sh
```

## Environment Variables

| Variable                   | Default                           | Description                                                       |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| `BASE_URL`                 | `http://ts-acuity-mw.ts.net:3001` | Base URL of the middleware under test                             |
| `AUTH_TOKEN`               | _(empty)_                         | Bearer token for Authorization header                             |
| `TARGET`                   | `unknown`                         | Result tag: `modal` or `k8s`                                      |
| `SERVICE_IDS`              | `53178494`                        | Comma-separated Acuity appointment type IDs                       |
| `DATE_MONTHS`              | current month,next month          | Comma-separated `YYYY-MM` months for `POST /availability/dates`   |
| `SLOT_DATES`               | tomorrow                          | Comma-separated `YYYY-MM-DD` dates for `POST /availability/slots` |
| `EXPECTED_CACHE_HIT_RATIO` | `0.8`                             | Expected fast-response ratio (10k test, informational)            |

## Running

```bash
cd bench/

# Against K8s (on tailnet):
AUTH_TOKEN=xxx TARGET=k8s ./run.sh

# Against Modal:
BASE_URL=https://your-org--acuity-mw.modal.run AUTH_TOKEN=xxx TARGET=modal ./run.sh
```

`run.sh` runs all three scenarios in sequence and writes results to:

```
results/<ISO8601_timestamp>-<TARGET>/
  smoke.json
  load-1k.json
  load-10k.json
```

## Scenarios

| Script           | VUs                 | Requests | Endpoints                                                               |
| ---------------- | ------------------- | -------- | ----------------------------------------------------------------------- |
| `k6-smoke.js`    | 1                   | 100      | `GET /services`                                                         |
| `k6-load-1k.js`  | 10 (ramped)         | ~1000    | `GET /services`, `POST /availability/dates`, `POST /availability/slots` |
| `k6-load-10k.js` | 20 (sustained 8min) | ~10000   | same as 1k                                                              |

## Thresholds

| Scenario | `http_req_failed` | `http_req_duration p(99)` |
| -------- | ----------------- | ------------------------- |
| smoke    | < 1%              | < 8 s                     |
| load-1k  | < 2%              | < 10 s                    |
| load-10k | < 5%              | < 15 s                    |

## Interpreting Results

The `--summary-export` JSON files contain aggregated metrics including
`http_req_duration`, `http_req_failed`, and (for 10k)
`cache_hint_fast_response`, `cache_hint_fast_services`,
`cache_hint_fast_dates`, and `cache_hint_fast_slots`.

The load scenarios intentionally use the same JSON `POST` protocol as the
application and parity harness. Do not convert availability reads back to query
string `GET` requests; those do not exercise the deployed bridge routes or the
Redis read-cache keys used by `MassageIthaca`.

Copy result directories into `paper/data/phase1/` to feed the comparison analysis:

```bash
cp -r results/<run>/ ../paper/data/phase1/<run>/
```
