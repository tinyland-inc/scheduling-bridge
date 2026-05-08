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

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth required) |
| GET | `/services` | List appointment types via `SERVICES_JSON` -> BUSINESS -> scraper fallback |
| GET | `/services/:id` | Get a specific service |
| POST | `/availability/dates` | Available dates for a service |
| POST | `/availability/slots` | Time slots for a specific date |
| POST | `/availability/check` | Check if a slot is available |
| POST | `/availability/refresh` | Enqueue async availability refresh |
| GET | `/availability/snapshot` | Read latest durable availability snapshot |
| POST | `/booking/create` | Create a booking (standard) |
| POST | `/booking/create-with-payment` | Deprecated sync paid booking endpoint; returns `410 ASYNC_REQUIRED` |
| POST | `/booking/jobs` | Enqueue async paid booking job |
| GET | `/jobs/:operationId` | Read async job status |

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

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `ACUITY_BASE_URL` | No | `https://example.as.me` | Acuity scheduling page URL |
| `BRIDGE_DATABASE_URL` | For strict async runtime | -- | Postgres queue/snapshot store for async jobs; takes precedence over Redis |
| `BRIDGE_DATABASE_SSL` | No | `false` | Enable SSL for `BRIDGE_DATABASE_URL` |
| `BRIDGE_DATABASE_MIGRATE` | No | `true` | Run async queue/snapshot schema creation at startup |
| `REDIS_URL` | For K8s read cache / Redis async runtime | -- | Redis read cache plus async queue/snapshot store when `BRIDGE_DATABASE_URL` is unset |
| `REDIS_PASSWORD` | No | -- | Password for `REDIS_URL` |
| `BRIDGE_REDIS_ASYNC_PREFIX` | No | `bridge-async:v1` | Redis key prefix for async jobs and snapshots |
| `BRIDGE_INLINE_WORKER_ENABLED` | No | `true` when Postgres or Redis is configured | Drain async jobs inside the HTTP container; set `false` only when a separate worker deployment is active |
| `BRIDGE_WORKER_POLL_MS` | No | `1000` | Worker queue poll interval |
| `BRIDGE_WORKER_BATCH_SIZE` | No | `5` | Maximum jobs drained per worker poll |
| `AUTH_TOKEN` | Recommended | -- | Bearer token for all endpoints (except /health) |
| `ACUITY_BYPASS_COUPON` | For payment bypass | -- | 100% gift certificate code |
| `PLAYWRIGHT_HEADLESS` | No | `true` | Run browser headless |
| `PLAYWRIGHT_TIMEOUT` | No | `30000` | Page operation timeout (ms) |
| `CHROMIUM_EXECUTABLE_PATH` | No | -- | Custom Chromium path (for Lambda/serverless) |
| `CHROMIUM_LAUNCH_ARGS` | No | -- | Comma-separated Chromium args |
| `SERVICES_JSON` | No | -- | Optional static service catalog to bypass live Acuity reads |
| `ACUITY_SERVICE_CACHE_TTL_MS` | No | `300000` | TTL for cached live service catalogs before BUSINESS/scraper refresh |
| `ACUITY_URL_READ_NETWORK_IDLE_MS` | No | `1500` | Bounded post-navigation network-idle settle for direct URL availability reads; set `0` to skip |
| `ACUITY_DATE_PREWARM_MONTHS` | No | `1` | Number of future months queued for async date refresh after a successful date read; max `3`, set `0` to disable |
| `ACUITY_SLOT_PREWARM_LIMIT` | No | `1` | Number of first available dates to warm in the slots cache after a successful Acuity dates read; max `3`, set `0` to disable |
| `SCHEDULING_BRIDGE_SLOT_PROFILE_THRESHOLD_MS` | No | `1500` | Threshold in ms for logging long-tail slot-read profile events |
| `SCHEDULING_BRIDGE_PROFILE_SLOT_READS` | No | `false` | Force logging of slot-read profile events even when under threshold |
| `MIDDLEWARE_RELEASE_SHA` | No | -- | Release commit SHA exposed via `/health` |
| `MIDDLEWARE_RELEASE_REF` | No | -- | Release ref/tag exposed via `/health` |
| `MIDDLEWARE_RELEASE_VERSION` | No | -- | Release version exposed via `/health` |
| `MIDDLEWARE_RELEASE_BUILT_AT` | No | -- | Build timestamp exposed via `/health` |
| `MIDDLEWARE_BUILD_TIMESTAMP` | No | -- | Legacy fallback build timestamp for `/health` |

### Observability

The bridge emits NDJSON logs to stdout/stderr for runtime analysis.

- `/health` remains the authoritative runtime-truth surface for downstream apps
- request handlers emit request-scoped structured events, including `requestId`
- long-tail slot reads emit `slot_read_profile` events with phase timings
- `SCHEDULING_BRIDGE_PROFILE_SLOT_READS=1` forces profile emission for all slot reads

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
