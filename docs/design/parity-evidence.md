# Trace-Conformance Parity Evidence (TIN-2072)

Status: harness landed; this document states exactly what a green run of the
harness proves and what it does not. Design contract:
[Flow DAG Formalization](flow-dag-formalization.md) §10 ("0.6.x — parity, then
flip", bullet 1) and §11 ("Trace conformance"). The `BRIDGE_FLOW_RUNNER` default
flip is gated on this suite being green.

## The harness

`src/server/__tests__/trace-conformance.test.ts` drives **both** execution paths
— the legacy production worker executor (`src/server/worker.ts`, flag off) and
the `runFlow` fold (`src/server/flow-runner.ts`, flag on) — over **identical
substituted stub step sets** (the same module-boundary seam style as
`flow-runner.test.ts`; no Chromium launches). Every stub is wrapped in a tracing
decorator that records, in execution order:

- one `scope-open` event per browser-session Scope acquisition (the legacy
  `runWizardStep` page-per-step lifecycle and the fold's one-Scope-per-segment
  lifecycle, counted by substituted session Layers on both paths);
- one `step` event per underlying step program invocation, with its outcome
  (`ok` / `error:<tag>`).

The recorded trace — ordered step ids, per-step outcomes, scope layout, and
terminal job status (plus result payloads, `createdAt` pinned) — is
deep-compared between the two paths, and the happy-path/failure-path traces are
additionally pinned as literals so a both-paths-equally-wrong regression cannot
pass the equality check.

## What a green run proves

| Scenario | Kinds covered | Assertion |
| --- | --- | --- |
| Happy path | booking, dates (via-url + wizard dispatch), slots (via-url + wizard dispatch) | identical traces, identical results, journal trail mirrors the executed order |
| Bypass-proof failure (`PAYMENT_BYPASS_NOT_PROVEN`) | booking | identical terminal status **and identical step cutoff** (submit/extract never invoked on either path) |
| Pre-submit failures (navigate, fill-form) | booking | identical cutoff, `failed_pre_submit`, retryable |
| REST execution-path guard | booking | identical (empty) trace and terminal |
| Submit failure / extract failure | booking | identical cutoff, `reconcile_required`, non-retryable |
| Job-level retry (requeue + re-lease, the only retry the legacy path performs) | booking, dates | identical cross-attempt traces and status transitions through the real `executeBridgeJob` machinery; re-lease re-runs from the top on both paths (no resume in 0.6.x, per design §5) |
| Segment layout | all three | the fold opens exactly as many session Scopes as the legacy worker, with the same step groupings; the plan-declared segments equal the worker-observed groupings (five single-step segments for booking, one for each read) |

Status-transition parity (`{status, code, step, retryable}`) for these paths is
additionally covered by `flow-runner.test.ts`; this harness extends it to full
trace identity (step order, outcomes, page lifecycle, and message parity).

## Known, intentional divergences (asserted, not hidden)

Two cases where the fold is deliberately *stricter* than the legacy path; both
are asserted explicitly in the harness so any drift in either direction fails:

1. **`COUPON_REQUIRED` front-loaded guard.** The legacy worker discovers a
   missing coupon only after running navigate + fill-form; the flagged executor
   guards before any browser work (`src/server/worker.ts`). Same terminal
   failure, strictly less vendor work.
2. **Ambiguous submit halts at submit.** When `submitBooking` reports
   `confirmationPageReached: false`, the fold classifies the unknown landing as
   `Diverged` at `acuity/submit` (`FLOW_DIVERGED`, `reconcile_required`,
   non-retryable) instead of blindly probing `extractConfirmation` from an
   ambiguous page as the legacy path does (which then fails at
   extract-confirmation with the same `reconcile_required`). The flagged trace
   is asserted to be a strict prefix of the legacy trace.

## What a green run does NOT prove

- **Live vendor behavior.** All step programs are stubs: selector drift, real
  Acuity wizard markup/timing, Playwright behavior, and network conditions are
  out of scope. Live-wizard evidence comes from shadow-mode metrics in
  production (`acuity_flow_shadow_runs_total` /
  `acuity_flow_shadow_step_mismatch_total`) and, later, the cassette corpus
  (design §11).
- **The non-worker legacy compositions.** Only the production worker executor
  is conformance-traced here. The `wizard.ts` adapter composition (one page for
  the whole booking — the known scoping divergence the plan deliberately does
  not mirror) and the `handler.ts` sync card-payment route are 0.7.0
  deletion-gate surfaces, not flip-gate surfaces.
- **REST booking execution** beyond the `REST_BOOKING_NOT_WIRED` guard (not
  wired on either path).
- **Journal durability.** Redis/Postgres journal semantics are covered
  separately by `journal-conformance.test.ts`; this harness uses the in-memory
  journal as evidence transport only.
- **Resume / idempotent re-submit.** 0.6.x has no segment-replay resume and no
  confirmation-probe gate; the retry tests prove both paths re-run from the top
  identically, which is the honest 0.6.x semantic (design §5).
