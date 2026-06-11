# scheduling-bridge

<!-- markdownlint-disable MD013 MD040 MD060 -->

Backend-agnostic scheduling adapter hub. Currently bridges Acuity Scheduling via Playwright browser automation, with architecture designed to support additional scheduling backends.

> Formerly `acuity-middleware`. Historical GitHub URLs may redirect, but the
> canonical repo is `Jesssullivan/scheduling-bridge`.

## Architecture

An HTTP server wrapping Playwright wizard flows that automate the Acuity booking UI. The bridge uses Effect TS for resource lifecycle management (browser/page acquisition and release).

```
HTTP Request
  -> server/handler.ts (route matching, auth, JSON serialization)
    -> acuity-service-catalog.ts (static env catalog -> BUSINESS -> scraper fallback)
    -> steps/ (Effect TS programs for each wizard stage)
      -> browser-service.ts (Playwright lifecycle via Effect Layer)
        -> selectors.ts (CSS selector registry with fallback chains)
```

### Key Components

- **server/handler.ts** -- Standalone Node.js HTTP server with Bearer token auth
- **acuity-service-catalog.ts** -- Shared service source order and cache for static config, BUSINESS extraction, and scraper fallback
- **browser-service.ts** -- Effect TS Layers for a warm shared browser process plus request-scoped page sessions
- **acuity-wizard.ts** -- Full `SchedulingAdapter` implementation (local Playwright or remote HTTP proxy)
- **remote-adapter.ts** -- HTTP client adapter for proxying to a remote middleware instance
- **selectors.ts** -- Single source of truth for all Acuity DOM selectors
- **steps/** -- Individual wizard step programs plus BUSINESS extraction helpers
- **acuity-scraper.ts** -- Deprecated read fallback for services, dates, and time slots

## Endpoints

| Method | Path                                     | Description                                                                |
| ------ | ---------------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/health`                                | Health check (no auth required)                                            |
| GET    | `/services`                              | List appointment types via `SERVICES_JSON` -> BUSINESS -> scraper fallback |
| GET    | `/services/:id`                          | Get a specific service                                                     |
| POST   | `/availability/dates`                    | Available dates for a service                                              |
| POST   | `/availability/slots`                    | Time slots for a specific date                                             |
| POST   | `/availability/check`                    | Check if a slot is available                                               |
| POST   | `/availability/refresh`                  | Enqueue async availability refresh                                         |
| GET    | `/availability/snapshot`                 | Read latest durable availability snapshot                                  |
| GET    | `/internal/availability/snapshot-canary` | Auth-gated durable snapshot layer proof                                    |
| POST   | `/internal/availability/heartbeat`       | Auth-gated bounded availability refresh heartbeat                          |
| POST   | `/internal/availability/readiness`       | Auth-gated read-only snapshot/queue readiness check                        |
| POST   | `/internal/availability/wait-ready`      | Auth-gated bounded heartbeat + readiness wait for deploy gates             |
| POST   | `/booking/create`                        | Create a booking (standard)                                                |
| POST   | `/booking/create-with-payment`           | Deprecated sync paid booking endpoint; returns `410 ASYNC_REQUIRED`        |
| POST   | `/booking/jobs`                          | Enqueue async paid booking job                                             |
| GET    | `/jobs/:operationId`                     | Read async job status                                                      |

Availability date/slot request handlers are snapshot-first after Redis read-cache
misses: a fresh durable snapshot returns immediately, a stale-but-not-expired
snapshot returns immediately and queues an async refresh, and an expired/missing
snapshot falls through to the Acuity read path. Serving a stale snapshot does
not re-stamp it as freshly observed; only successful Acuity reads or worker
refresh jobs advance snapshot freshness.

`GET /internal/availability/snapshot-canary?kind=dates|slots&serviceId=...&scope=...`
is an operator canary for K8s/runtime proof. It is hidden unless `AUTH_TOKEN`
is configured, requires bearer auth when enabled, bypasses the Redis read cache,
reads the durable snapshot store directly, and returns only metadata, count, and
duration. Successful canary hits increment
`acuity_availability_snapshot_served_total` and
`acuity_availability_snapshot_read_duration_seconds`, so operators can prove the
bridge snapshot layer separately from app Redis hits and bridge Redis hits.

`POST /internal/availability/heartbeat` is the operator/cron entrypoint for
queue-driven availability refresh. It is hidden unless `AUTH_TOKEN` is
configured and requires bearer auth when enabled. The request body contains
weighted demand:

```json
{
	"maxJobs": 12,
	"idempotencyWindowMs": 300000,
	"demands": [
		{
			"serviceId": "53178494",
			"serviceName": "TMD single session",
			"weight": 10,
			"months": ["2026-06", "2026-07"],
			"dates": ["2026-06-15"]
		}
	]
}
```

The heartbeat uses weighted fairness across service/request groups before
`maxJobs` is applied. A higher `weight` biases additional work toward that
demand, but every active demand group receives early representation before one
high-weight service can consume the whole enqueue budget. Equal-weight demand is
round-robin interleaved by request order. The handler skips fresh durable
snapshots, enqueues stale/expired/missing date and slot refresh jobs up to
`maxJobs`, and uses a time-windowed idempotency key so frequent cron runs do not
create duplicate job storms. It does not run browser automation on the HTTP
request path; the async worker owns the Acuity read. If an idempotency key
resolves to a retryable failed job, heartbeat requeues that existing operation
before reporting it as work; non-retryable terminal jobs are reported under
`skipped` instead of masquerading as newly enqueued refreshes.

### Queue Hygiene

Bridge `0.5.13` supports bounded worker drain concurrency through
`BRIDGE_WORKER_CONCURRENCY`. The package default remains `1`; the MassageIthaca
K8s deployment currently opts into `2` through Blahaj/OpenTofu after proving the
datepicker readiness gate remains green.

Readiness and queue stats are related but not identical. A scoped datepicker
readiness check can be green while historical retryable refresh failures remain
in the async store until the store TTL expires. Live K8s sampling after the
`0.5.9` rollout found fresh datepicker snapshots and no runnable backlog, but
also retained failed refresh records from transient browser/network failures:

- `NETWORK` / `PAGE_FAILED` on date and slot refresh jobs
- `SCRAPE_FAILED` calendar-load timeouts on date refresh jobs

Track this as queue-hygiene work, not a regression of the sustained datepicker
gate. `Jesssullivan/scheduling-bridge#129` owns the next package pass: failed
refresh observability, retention/TTL configuration, retry/stat semantics, and
tests.

`POST /internal/availability/readiness` is the operator read path for
cutover/deploy proof. It accepts the same demand shape as heartbeat, does not
enqueue jobs, and returns `200` when every requested date/slot scope has a
snapshot newer than the configured freshness floor and the async queue is
healthy. It returns `409` with explicit blockers when any scope is missing,
stale, expired, retryable-failed, or when the oldest runnable queue item is too
old. Defaults are `snapshotFreshnessFloorMs=90000` and
`maxOldestQueuedAgeMs=120000`.

`POST /internal/availability/wait-ready` is the bounded deploy/operator action.
It runs the existing heartbeat enqueue/requeue logic once, then polls the
read-only readiness evaluator until ready or timeout. It never runs Acuity
browser automation in the HTTP request; workers still own Acuity reads. Defaults
are `timeoutMs=60000` and `pollMs=1000`.

### Health Contract

`GET /health` is the stable downstream runtime-truth surface.

In addition to basic runtime data, it now publishes:

- release tuple:
  - `releaseSha`
  - `releaseRef`
  - `releaseVersion`
  - `releaseBuiltAt`
  - nested `release.{ sha, ref, version, builtAt, modalEnvironment }`
- protocol tuple:
  - `protocolVersion`
  - nested `protocol.version`
  - `protocol.flowOwner = "scheduling-bridge"`
  - `protocol.backend = "acuity"`
  - `protocol.transport = "http-json"`
  - `protocol.endpoints`
  - `protocol.capabilities`

Downstream apps should use this tuple to assert which bridge release and protocol
surface they are talking to during beta validation and rollout claims.

This tuple is the supported runtime truth surface for adopters. Downstream apps
should not infer bridge ownership from package metadata, branch names, or Modal
dashboard state when `/health` is available.

## Environment Variables

| Variable                                      | Required                                 | Default                                     | Description                                                                                                                  |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                        | No                                       | `3001`                                      | Server port                                                                                                                  |
| `ACUITY_BASE_URL`                             | No                                       | `https://example.as.me`                     | Acuity scheduling page URL                                                                                                   |
| `BRIDGE_DATABASE_URL`                         | For strict async runtime                 | --                                          | Postgres queue/snapshot store for async jobs; takes precedence over Redis                                                    |
| `BRIDGE_DATABASE_SSL`                         | No                                       | `false`                                     | Enable SSL for `BRIDGE_DATABASE_URL`                                                                                         |
| `BRIDGE_DATABASE_MIGRATE`                     | No                                       | `true`                                      | Run async queue/snapshot schema creation at startup                                                                          |
| `REDIS_URL`                                   | For K8s read cache / Redis async runtime | --                                          | Redis read cache plus async queue/snapshot store when `BRIDGE_DATABASE_URL` is unset                                         |
| `REDIS_PASSWORD`                              | No                                       | --                                          | Password for `REDIS_URL`                                                                                                     |
| `BRIDGE_REDIS_ASYNC_PREFIX`                   | No                                       | `bridge-async:v1`                           | Redis key prefix for async jobs and snapshots                                                                                |
| `BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS`          | No                                       | `604800`                                    | Redis TTL for async job and idempotency records; lower in K8s if historical retryable refresh failures make queue stats noisy |
| `BRIDGE_INLINE_WORKER_ENABLED`                | No                                       | `true` when Postgres or Redis is configured | Drain async jobs inside the HTTP container; set `false` only when a separate worker deployment is active                     |
| `BRIDGE_WORKER_POLL_MS`                       | No                                       | `1000`                                      | Worker queue poll interval                                                                                                   |
| `BRIDGE_WORKER_BATCH_SIZE`                    | No                                       | `5`                                         | Maximum jobs drained per worker poll                                                                                         |
| `BRIDGE_WORKER_CONCURRENCY`                   | No                                       | `1`                                         | Maximum jobs executed concurrently within one worker poll; raise only when browser/page limiter and queue metrics support it |
| `BRIDGE_SNAPSHOT_STALE_MS`                    | No                                       | `300000`                                    | Age after which a durable availability snapshot is served stale and refresh is queued                                        |
| `BRIDGE_SNAPSHOT_EXPIRES_MS`                  | No                                       | `1800000`                                   | Age after which a durable availability snapshot is ignored and a live Acuity read is required                                |
| `BRIDGE_HEARTBEAT_MAX_JOBS`                   | No                                       | `12`                                        | Default max refresh jobs enqueued by one internal heartbeat request; request values are capped at `100`                      |
| `BRIDGE_HEARTBEAT_IDEMPOTENCY_WINDOW_MS`      | No                                       | `300000`                                    | Default time bucket for heartbeat idempotency keys                                                                           |
| `BRIDGE_READINESS_FRESHNESS_FLOOR_MS`         | No                                       | `90000`                                     | Default required snapshot freshness for internal readiness gates                                                             |
| `BRIDGE_READINESS_MAX_OLDEST_QUEUED_AGE_MS`   | No                                       | `120000`                                    | Default maximum oldest runnable queue age before readiness fails                                                             |
| `BRIDGE_READINESS_WAIT_TIMEOUT_MS`            | No                                       | `60000`                                     | Default timeout for `/internal/availability/wait-ready`                                                                      |
| `BRIDGE_READINESS_WAIT_POLL_MS`               | No                                       | `1000`                                      | Default poll interval for `/internal/availability/wait-ready`                                                                |
| `AUTH_TOKEN`                                  | Recommended                              | --                                          | Bearer token for all endpoints (except /health)                                                                              |
| `ACUITY_BYPASS_COUPON`                        | For payment bypass                       | --                                          | 100% gift certificate code                                                                                                   |
| `PLAYWRIGHT_HEADLESS`                         | No                                       | `true`                                      | Run browser headless                                                                                                         |
| `PLAYWRIGHT_TIMEOUT`                          | No                                       | `30000`                                     | Page operation timeout (ms)                                                                                                  |
| `CHROMIUM_EXECUTABLE_PATH`                    | No                                       | --                                          | Custom Chromium path (for Lambda/serverless)                                                                                 |
| `CHROMIUM_LAUNCH_ARGS`                        | No                                       | --                                          | Comma-separated Chromium args                                                                                                |
| `SERVICES_JSON`                               | No                                       | --                                          | Optional static service catalog to bypass live Acuity reads                                                                  |
| `ACUITY_SERVICE_CACHE_TTL_MS`                 | No                                       | `300000`                                    | TTL for cached live service catalogs before BUSINESS/scraper refresh                                                         |
| `ACUITY_URL_READ_NETWORK_IDLE_MS`             | No                                       | `1500`                                      | Bounded post-navigation network-idle settle for direct URL availability reads; set `0` to skip                               |
| `ACUITY_DATE_PREWARM_MONTHS`                  | No                                       | `1`                                         | Number of future months queued for async date refresh after a successful date read; max `3`, set `0` to disable              |
| `ACUITY_SLOT_PREWARM_LIMIT`                   | No                                       | `1`                                         | Number of first available dates to warm in the slots cache after a successful Acuity dates read; max `3`, set `0` to disable |
| `SCHEDULING_BRIDGE_SLOT_PROFILE_THRESHOLD_MS` | No                                       | `1500`                                      | Threshold in ms for logging long-tail slot-read profile events                                                               |
| `SCHEDULING_BRIDGE_PROFILE_SLOT_READS`        | No                                       | `false`                                     | Force logging of slot-read profile events even when under threshold                                                          |
| `MIDDLEWARE_RELEASE_SHA`                      | No                                       | --                                          | Release commit SHA exposed via `/health`                                                                                     |
| `MIDDLEWARE_RELEASE_REF`                      | No                                       | --                                          | Release ref/tag exposed via `/health`                                                                                        |
| `MIDDLEWARE_RELEASE_VERSION`                  | No                                       | --                                          | Release version exposed via `/health`                                                                                        |
| `MIDDLEWARE_RELEASE_BUILT_AT`                 | No                                       | --                                          | Build timestamp exposed via `/health`                                                                                        |
| `MIDDLEWARE_BUILD_TIMESTAMP`                  | No                                       | --                                          | Legacy fallback build timestamp for `/health`                                                                                |

### Observability

The bridge emits NDJSON logs to stdout/stderr for runtime analysis.

- `/health` remains the authoritative runtime-truth surface for downstream apps
- request handlers emit request-scoped structured events, including `requestId`
- long-tail slot reads emit `slot_read_profile` events with phase timings
- `SCHEDULING_BRIDGE_PROFILE_SLOT_READS=1` forces profile emission for all slot reads
- internal readiness emits queue depth, oldest queue age, snapshot age, readiness
  result, and per-scope freshness metrics

## Deployment

### Runtime Provider Truth

The stable bridge contract is the Node HTTP server, protocol surface, and
`/health` tuple. Provider names are deployment details, not the consumer
contract.

- Accepted next-production route: K8s/container runtime managed from
  infrastructure.
- Legacy proofing provider: Modal. Automatic Modal deploys are disabled; the
  manual workflow is retained only for deliberate decommissioning or
  forensic fallback while TIN-981 closes the surface.
- Compatibility target: Docker image with the same `dist/server/handler.js`
  entrypoint.
- Consumer apps should configure the remote bridge with
  `SCHEDULING_BRIDGE_URL` and `SCHEDULING_BRIDGE_AUTH_TOKEN`; legacy
  `MODAL_*` names are transition aliases in consumer/infra repos.

## Node Runtime Policy

The npm package supports active downstream consumer runtimes on Node 22 and
Node 24. CI validates the host test suite on both majors.

The bridge-owned Bazel toolchain, Nix dev shell, Docker/K8s image, and publish
workflow intentionally stay on Node 24. Downstream apps should not infer that
they must also run Node 24 unless they deploy the bridge runtime itself.

### Standalone Node.js

```bash
pnpm install
pnpm dev           # Development with tsx against src/server/handler.ts
# or
pnpm build && pnpm start  # Materialize Bazel-derived dist/ and start it
```

### Docker

```bash
docker build -t scheduling-bridge .
docker run -p 3001:3001 \
  -e AUTH_TOKEN=your-secret-token \
  -e ACUITY_BASE_URL=https://YourBusiness.as.me \
  -e ACUITY_BYPASS_COUPON=your-coupon-code \
  scheduling-bridge
```

### Legacy Modal Labs

```bash
# Automatic Modal deploys are disabled. The manual workflow requires an
# explicit legacy-modal acknowledgement and should only be used for
# decommissioning or forensic fallback while TIN-981 is open.
# The Modal workflow materializes the Bazel-derived pkg/ before deploy.
modal deploy modal-app.py
```

#### Supported fallback deployment path

The Modal deployment path is legacy-only:

1. manually dispatch `.github/workflows/deploy-modal.yml`
2. type `legacy-modal` in `acknowledge_legacy_modal`
3. inject `MIDDLEWARE_RELEASE_SHA`, `MIDDLEWARE_RELEASE_REF`,
   `MIDDLEWARE_RELEASE_VERSION`, and `MIDDLEWARE_RELEASE_BUILT_AT`
4. verify the resulting bridge tuple via `GET /health`

Operationally, this means:

- Modal deployment is not automatic release truth
- the live bridge should be identified by the `/health` release + protocol tuple
- downstream apps should validate the tuple they expect before making rollout claims

### Nix

```bash
nix develop   # Enter dev shell with Node.js + Playwright
pnpm install
pnpm dev
```

<!-- markdownlint-enable MD013 MD040 MD060 -->

## Release Authority

Current release authority:

- canonical repo: `Jesssullivan/scheduling-bridge`
- npm package: `@tummycrypt/scheduling-bridge`
- GitHub Packages mirror: `@jesssullivan/scheduling-bridge`

The current publish + deploy shape is:

1. release metadata declared once
2. Bazel validates/builds the publishable artifact
3. CI dry-runs the extracted Bazel package surface before release
4. GitHub Actions publishes that extracted artifact
5. infrastructure can deploy the K8s/container runtime from the same package
   artifact and image entrypoint
6. downstream apps consume the published package and verify the live runtime
   tuple via `/health`

This repo is the sole owner of Acuity automation concerns. App repos and shared
packages may consume the bridge and assert its runtime tuple, but they should
not duplicate bridge runtime ownership or release truth logic.

## Runner Authority

Package CI and publish currently use the shared `js-bazel-package` workflow with
`runner_mode: shared` and `publish_mode: same_runner`.

The concrete shared-runner labels come from repository Actions variables and
must be proven by green workflow runs before they are treated as operational
truth. Keep private runner topology and apply details out of this public repo.

## Development

```bash
pnpm install      # Install dependencies
pnpm dev          # Start dev server with tsx
pnpm typecheck    # Run Bazel typecheck target
pnpm build        # Materialize local pkg/ and dist/ from bazel-bin/pkg
pnpm test         # Run Bazel test target
pnpm docs:generate
```

## License

MIT
