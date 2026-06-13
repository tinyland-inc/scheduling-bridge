# scheduling-bridge Agent Notes

<!-- markdownlint-disable MD013 -->

This file is the working brief for AI agents and LLMs operating in the
`scheduling-bridge` repo, formerly `acuity-middleware`, which publishes as
`@tummycrypt/scheduling-bridge`.

## Repo Role

This repo is the remote automation service.

It owns:

- Acuity browser automation
- Playwright orchestration
- Effect-based resource management around browser/page lifecycle
- remote HTTP endpoints for services, availability, slots, booking, and health
- bridge runtime packaging for Modal, Docker, and Kubernetes/container targets

It does **not** own:

- Vercel application deployment
- application-specific environment switching
- site-specific admin UI
- reusable, backend-agnostic UI components
- Kubernetes cluster state or public edge routing; those live in the
  infrastructure repo

## Strategic Goal

This repo is the bridge layer that allows a business to:

1. keep Acuity running
2. gain control over scheduling reads and booking orchestration
3. migrate gradually toward a homegrown backend without a big-bang cutover

That makes this repo central to the migration paper and to the operational beta-to-prod story.

## Current Tracking

As of `2026-06-11`, the active structural work here is:

- `TIN-89` package, Bazel, CI, publish, and dependency truth across shared
  scheduling packages
- `TIN-165` bazel-registry generation from standalone package truth
- `TIN-189` Modal-to-K8s bridge migration and parity bake
- release, tag, and npm authority cleanup tracked in GitHub issue `#76`
- runtime/provider decoupling tracked in GitHub issue `#44`
- runner reachability and shared-runner adoption, still pending proof before it
  becomes this public repo's live workflow contract

Operationally relevant truth:

- current package metadata is `@tummycrypt/scheduling-bridge` `0.6.1`,
  delivered through GitHub Packages as `@jesssullivan/scheduling-bridge`
- npmjs is frozen at `0.5.11` and retired for new versions; existing npmjs
  consumers keep resolving the frozen versions
- `0.6.1` resolves `tummycrypt_scheduling_kit` `0.9.1` from the Bazel module
  graph and declares `@tummycrypt/scheduling-kit ^0.9.1` as a required
  `peerDependency` (npm metadata); `0.5.13` depended on the kit `^0.8.0` via
  npm metadata
- the `0.5.x` line is the async bridge redesign lane: async booking jobs,
  availability snapshots, Redis/Postgres async stores, and request-path
  availability prewarm enqueueing
- package metadata, git tags, npm dist-tags, GitHub releases, and deployed
  bridge runtime tuples remain separate authority surfaces and should be
  verified explicitly

## Deployment Truth

### Runtime Contract

The provider-agnostic bridge contract is the Node HTTP server plus `/health`
runtime tuple. Consumers should talk about this service as the scheduling
bridge, not as "Modal", unless they are discussing the Modal deployment itself.

Current provider truth:

- K8s/container execution is the accepted next-production bridge route and is
  the current K8s shadow runtime for MassageIthaca scheduling-bridge traffic.
- Modal remains legacy proofing context only. The forward production path is
  K8s-native bridge execution; do not re-enable automatic Modal deploys without
  reopening the provider-spend/runtime decision.
- Cluster state, tailnet exposure, and public-edge routing are infrastructure
  concerns outside this repo.
- Docker/container execution must mirror the same built Node entrypoint so K8s
  and other providers do not become separate runtime implementations.
- Downstream apps should configure bridge endpoints with
  `SCHEDULING_BRIDGE_URL` / `SCHEDULING_BRIDGE_AUTH_TOKEN`; legacy `MODAL_*`
  names are compatibility aliases outside this repo, not the forward contract.

### Modal

Modal is the legacy proofing/fallback remote deployment surface.

Important facts:

- the deployed server should run `dist/server/handler.js`
- the Modal image must stay aligned with the same built artifact used by `pnpm start`
- warm-container behavior and concurrency settings are part of the real latency story
- Modal-specific docs and workflows are retained until fallback/live-beta
  traffic is retired deliberately

### Docker / K8s Container

Docker and K8s containers should mirror the same `dist/server/handler.js`
entrypoint and runtime assumptions as every other provider.

If Modal, Docker, and K8s drift from the actual Node entrypoint, that is an
operational bug.

K8s async runtime truth:

- `BRIDGE_DATABASE_URL` is the strict durable async queue/snapshot store when
  Postgres is configured.
- `REDIS_URL` is also a valid K8s async store when Postgres is absent; it backs
  both the read cache and the Redis job/snapshot store.
- `BRIDGE_INLINE_WORKER_ENABLED` defaults on when Postgres or Redis is
  configured, so a single HTTP deployment can drain queued jobs until a
  separate worker deployment exists.
- `BRIDGE_FLOW_RUNNER` defaults on as of `0.6.x`: async jobs execute through the
  `runFlow` fold, the flip gated on the trace-conformance parity evidence
  (`docs/design/parity-evidence.md`, design §10). Rollback is `BRIDGE_FLOW_RUNNER=0`
  (or `false`), which restores the byte-for-byte legacy worker path; shadow
  metrics then diff the legacy trace against the plan the fold would have run.
- request-path date/slot prewarm must enqueue async refresh jobs; browser
  scraping for prewarm is worker-owned, not request-owned.
- cutover claims for queue/cache readiness should use the auth-gated
  `/internal/availability/readiness` or `/internal/availability/wait-ready`
  endpoints. The former is read-only; the latter may run heartbeat/requeue once
  and then poll readiness, but neither endpoint may run Acuity browser
  automation directly on the HTTP request path.

### Release Coordination

The app repo and this repo do not currently share a single atomic release mechanism.

That means:

- a new app build can point at an older bridge release
- a new bridge release can affect beta without any matching app deploy

Any promotion analysis must explicitly check bridge release identity and health.

Package graph rule:

- do not let bridge metadata lag behind the `scheduling-kit` version actually
  required by downstream apps

## Architecture Notes

Current high-level flow:

HTTP request
-> `server/handler.ts`
-> shared service catalog resolution
-> step programs
-> browser resource layer
-> Playwright/Acuity UI

Key architectural lessons already established:

- request-scoped pages are better than serializing all traffic through one singleton tab
- warm browsers matter
- false-empty Acuity reads are real and should be retried carefully
- URL-based direct reads are preferable when Acuity ids allow them
- shared service catalog logic should not be duplicated across local and remote paths

## Effect Guidance

Effect is useful here because this repo truly has resource lifecycle problems:

- browser startup and reuse
- page acquisition/release
- retry semantics
- service composition

Use Effect where it improves correctness and lifecycle clarity.

Do not add needless abstraction when simple synchronous code is sufficient.

## Performance Guidance

Treat latency work here as first-class product work.

Important performance dimensions:

- cold health path
- service catalog read latency
- date read latency
- slot read latency
- booking warm-up behavior
- false-empty calendar reads
- concurrency / contention under multiple booking sessions

If beta feels slow, do not dismiss that as “just Playwright.” Measure the step cost and reduce avoidable browser choreography first.

## CI / Publishing Truth

Important commands:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm docs:generate
```

Delivery doctrine:

- the Bzlmod module graph through `tinyland-inc/bazel-registry` is the SSOT
  delivery mechanism
- GitHub Packages `@jesssullivan/scheduling-bridge` is the derived
  out-of-ecosystem package, built from the Bazel `//:pkg` artifact
  (`./bazel-bin/pkg`)
- npmjs `@tummycrypt/scheduling-bridge` is retired for new versions and frozen
  at `0.5.11`; `npm_publish_mode: disabled` is permanent policy, not a
  temporary outage

The canonical GitHub repo is `Jesssullivan/scheduling-bridge`; historical
`Jesssullivan/acuity-middleware` URLs may redirect. The npm-style package name
remains `@tummycrypt/scheduling-bridge`. Preserve that distinction.

Current CI and publish workflows use the shared `js-bazel-package` workflow with:

- `runner_mode: shared`
- `publish_mode: same_runner`
- `npm_publish_mode: disabled` in the publish workflow (npmjs lane retired)
- `bazel_targets: "//:pkg"`
- `package_dir: ./bazel-bin/pkg`

That means Bazel-built package output is already part of the CI/publish path.
Do not regress publish lanes back to ad hoc pnpm packaging without explicitly
re-opening the package authority decision.

<!-- markdownlint-enable MD013 -->

Current runner truth:

- the public workflow contract names the runner policy, not private runner
  topology
- the concrete shared-runner labels come from repository Actions variables and
  must be proven by green workflow runs before being treated as operational truth
- keep private runner topology, cluster names, and apply details out of this
  public repo; track those in the private infrastructure repo and Linear

## Important Files

- `src/server/handler.ts`
- `src/shared/browser-service.ts`
- `src/shared/acuity-service-catalog.ts`
- `src/adapters/acuity/wizard.ts`
- `src/adapters/acuity/steps/**`
- `modal-app.py`
- `Dockerfile`
- `MODULE.bazel`
- `BUILD.bazel`
- `flake.nix`
- `mkdocs.yml`
- `docs/generated/repo-facts.md`
- `llms.txt`
- `scripts/build-derived-artifacts.mjs`
- `scripts/check-artifact-authority.mjs`
- `scripts/check-release-metadata.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/publish.yml`

## Guardrails

- Do not let Modal/Docker entrypoints drift from the real built server.
- Do not reintroduce singleton-page contention without a compelling measured reason.
- Do not hide false-empty availability behavior behind silent caches.
- Do not confuse this repo with the reusable UI/package layer.
- Do not let the bridge package declare stale `scheduling-kit` dependencies
  while downstream apps have already moved on.
