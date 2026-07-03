# ASE 2026 Industry Showcase — Submission Provenance

This note is the operator-facing submission packet for the paper
[`docs/paper.md`](../paper.md). It carries (1) the final fact-checked
abstract, (2) the ASE Industry Showcase CFP requirements, and (3) the
fact-check table (claim → status → evidence) so every empirical claim in
the abstract is traceable before submission.

**DO NOT SUBMIT from here — submission is the operator's act.** This
document is reference material assembled for review.

---

## 1. Final fact-checked abstract

**Title:** Typed Browser Automation as an Anti-Corruption Layer: A FOSS
Offramp Pattern for SaaS Vendor Lock-in

**Author:** Jess Sullivan, Tinyland Inc.

> Small-business SaaS scheduling platforms create vendor lock-in through
> API paywalls and proprietary data formats, leaving owner-operators
> unable to read or move their own appointment data without paying for an
> API tier. This experience report describes a typed browser-automation
> anti-corruption layer (ACL) that we ran in production for a real
> massage-therapy practice, and the software-engineering practice of
> carrying it from a feature-flagged migration to a completed,
> deleted-legacy system. The architecture separates a vendor-neutral
> contract -- a 17-method scheduling adapter interface, every method
> returning a monadic Effect for composable, typed error handling -- into
> a standalone library (scheduling-kit), while vendor-specific automation
> lives in a separate adapter hub (scheduling-bridge); each locked-in
> backend gets its own adapter package, giving small businesses a reusable
> FOSS offramp. The shipped browser backend (Acuity) replaces 8 REST
> endpoints that are blocked behind the vendor's paid API tier, driving
> them through headless DOM automation against a React single-page app
> alone. The middleware has run in production since March 2026 (now on a
> self-hosted Kubernetes cluster, having migrated off the original
> serverless substrate consuming the same container artifact), validated
> by a one-time campaign that automated 604 legacy appointments across 62
> weeks of historical calendar data.
>
> The engineering contribution is how we modeled and then retired the ACL
> with evidence rather than faith. Each booking flow is authored once as
> typed effect definitions, and a serializable flow DAG -- a FlowPlan
> carrying a sha256 content hash -- is derived as a projection of the very
> definitions that execute, never as a second, hand-maintained source of
> truth. A single ~100-line execution combinator (one fold over the
> derived plan) replaced three divergent hand-written booking compositions
> whose page-lifecycle scoping had quietly drifted apart; that divergence
> is now structurally inexpressible. To migrate without trusting the
> rewrite, we recorded golden step-traces from the three real legacy
> compositions before deleting them, then made a conformance harness
> assert the fold reproduces those traces byte-for-byte across every happy
> and failure path -- an anti-renaming guarantee that the surviving path is
> behaviorally the old one, not a silent regression (the harness
> additionally pins the expected traces inline so a corrupted golden cannot
> mask a broken fold). At the deletion gate (released in bridge 0.7.0) we
> deleted all three legacy compositions, removed the migration feature
> flag, its kill switch, and its shadow-comparison mode -- a net change of
> 538 insertions against 1,305 deletions across 16 files -- leaving the
> fold as the sole code path. We treat that removal, not its existence, as
> the migration's success criterion: an ACL's promised temporariness
> discharged as a concrete, test-gated deletion event. Because each flow
> carries its own typed effect-requirement (R) channel,
> transport-agnosticism is a compile-time property rather than a hope: a
> read-only CalCom REST adapter reuses the identical availability-flow
> definitions over an HTTP client, and a source-level type fence proves its
> steps never demand a browser service or scope, so a REST flow provisions
> no browser layer. Two distinct adopter applications now consume the stack
> end-to-end and authentication-free -- one consuming both the kit and the
> bridge, a second the kit alone -- pulling the packages from committed,
> vendored tarballs built from a single Bazel package artifact rather than
> an authenticated registry, removing per-consumer credential plumbing from
> CI, container builds, and dependency automation. We discuss practical
> challenges honestly: the fragility of DOM automation against an evolving
> SPA; capping the dual-path migration window to a single minor release and
> closing it with recorded-trace conformance; de-tenanting vendor selectors
> into per-tenant data so shared automation never names a tenant; and the
> limits of the result -- the deletion gate retires the bridge's internal
> divergent compositions and its dual-path runtime flag, not the vendor
> relationship itself, with additional browser-backed vendors and full
> application-level vendor sunset remaining future work. The lesson for
> practitioners is that capturing behavior as golden traces before deletion
> converts "delete the strangler" from a leap of faith into a verifiable
> engineering step, and that a typed anti-corruption layer can give small
> businesses a credible, deployed exit from proprietary scheduling
> services.

---

## 2. ASE 2026 Industry Showcase — CFP requirements summary

> **Deadline flag (operator action required):** The confirmed official
> ASE 2026 Industry Showcase dates are **abstract 23 Apr 2026 / paper 30
> Apr 2026 (AoE)** — both already past as of 2026-06-14; the HotCRP portal
> reports submissions CLOSED. The "2026-06-23" date assumed elsewhere does
> **not** match this track (it may belong to a different ASE 2026 track).
> The operator decides the target cycle (a still-open ASE 2026 track, the
> ASE 2027 Industry Showcase cycle, or contacting the chairs). Requirements
> below are stable year-over-year (ASE 2025 had an identical structure), so
> the abstract built to this spec carries over with near-zero rework.

| Requirement | Value |
|---|---|
| Track | ASE 2026 Industry Showcase (single-blind; authors NOT anonymized) |
| Submission type | Full paper, two-stage (abstract registered ~1 week before the full-paper PDF) |
| Length — short | 5 pages + 1 page references (recommended: experience report / tech-transfer story) |
| Length — long | 10 pages + 2 pages references |
| Template | ACM Proceedings Template, `\documentclass[sigconf,review]{acmart}` (NOT IEEE) |
| Format | PDF |
| Mandatory (new for 2026) | Data Availability Statement **after** Conclusions, within page limit, pointing to public DOI-archived artifacts |
| Editorial bar | Impact + real-world evidence over novelty; experience reports / tech-transfer welcome; **marketing/PR explicitly excluded** |
| Evaluation expectation | On real-world industrial data or vs. pre-existing industrial best practices |
| Review | ≥3 Industry Showcase PC members; accepted papers in ASE 2026 proceedings; ≥1 author registers + presents |
| Track home | <https://conf.researchr.org/track/ase-2026/ase-2026-industry-showcase> |
| Important dates | <https://conf.researchr.org/dates/ase-2026> |
| Submission system (operator-only) | <https://ase26-industry.hotcrp.com/> (currently CLOSED) |
| Conference | 12–16 Oct 2026, Munich, Germany (41st IEEE/ACM ASE) |

### Pre-submission checklist (for the operator)

- [ ] Convert `docs/paper.md` into ACM `acmart` sigconf + `review`
      (NOT IEEE). The current source is Markdown; an ACM `.tex` rendering
      is required for this track.
- [ ] Choose length target (SHORT 5+1 recommended for an experience
      report; LONG 10+2 if evaluation depth warrants). Do not exceed.
- [ ] Keep author/affiliation/product/repo names (single-blind track).
- [ ] Add a mandatory **Data Availability Statement** after Conclusions
      pointing to a public DOI-archived artifact (e.g. a Zenodo snapshot of
      `Jesssullivan/scheduling-bridge` + `scheduling-kit`).
      **[OPERATOR-VERIFY a real DOI exists, or mark the statement clearly.]**
- [ ] Resolve all `<!-- OPERATOR-VERIFY: ... -->` comments in
      `docs/paper.md`.
- [ ] Confirm the target cycle given the closed ASE 2026 window.

> Note: the separate companion paper
> [`acuity-middleware-paper.tex`](acuity-middleware-paper.tex) is a
> *distinct* work ("From Serverless to Cluster: O(1) Cache-Coherent
> Scraping of a Closed-Source Scheduling API"; SETNX single-flight). It
> already uses `acmart` sigconf and its own (unrelated) abstract; it was
> **not** overwritten with this abstract because the two are different
> papers. It still builds cleanly (`pnpm paper:build` / tectonic).

---

## 3. Fact-check table (claim → status → evidence)

Every empirical/quantitative claim in the abstract traces to the
codebase, git history, Linear, or the existing paper. Line references are
against `Jesssullivan/scheduling-bridge` @ `main` (HEAD `0c7ec4b`, version
0.7.0).

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | SaaS scheduling lock-in via API paywalls / proprietary formats; owners can't move their own data without an API tier | verified | `docs/paper.md` Abstract; §I.18 (HTTP 403 on Powerhouse paid tier; data only via web UI); §II.F (API restricted by pricing tier) |
| 2 | Typed browser-automation ACL run in production for a real massage-therapy practice | verified | `docs/paper.md` Abstract; §I; §VII ("production since March 2026"); §V.A |
| 3 | 17-method vendor-neutral adapter split into `scheduling-kit` (lib) + `scheduling-bridge` (adapter hub) | verified | `docs/paper.md` Abstract, §I, §VII; `docs/design/flow-dag-formalization.md:31` ("scheduling-kit owns the 17-method SchedulingAdapter") |
| 4 | Every adapter method returns a monadic `Effect` for typed error handling | verified | `docs/paper.md` §III.B (`SchedulingResult<T> = Effect<T, SchedulingError>`); `package.json` effect dep |
| 5 | Each locked-in backend gets its own adapter package (reusable FOSS offramp) | verified | `docs/paper.md` Abstract, contribution #2; Linear TIN-2035 (Done); adopter PRs MassageIthaca #478, software.tinyland.dev-booking #11 |
| 6 | Shipped Acuity browser backend replaces 8 REST endpoints blocked behind the paid tier, via headless DOM automation against a React SPA | verified | `docs/paper.md` Abstract ("8 blocked REST API endpoints through DOM interaction alone", "React SPA with Emotion CSS"); §I.18 |
| 7 | In production since March 2026 | verified | `docs/paper.md` Abstract, §VII ("Deployed in production since March 2026"). ~3 months in as of 2026-06-14 |
| 8 | Now on a self-hosted Kubernetes cluster, migrated off the original serverless substrate, same container artifact | verified | `docs/design/flow-dag-formalization.md` (K8s RKE2, 4 replicas, tailnet-only); `AGENTS.md` (K8s current, Modal legacy/fallback, same `dist/server/handler.js`); `Dockerfile` (Node 24) |
| 9 | One-time campaign automated 604 legacy appointments across 62 weeks of historical calendar data | verified | `docs/paper.md` Abstract, §V.A ("62 weeks of historical calendar data"; table "Appointments verified \| 604") |
| 10 | Each flow authored once as typed effect definitions; FlowPlan DAG derived as a projection of the executing definitions, no second source of truth | verified | `docs/design/flow-dag-formalization.md:92-93,289` ("plans are output, never input"); `src/flow/flow.ts` (build derives FlowPlan); `src/flow/plan.ts` |
| 11 | FlowPlan carries a sha256 content hash | verified | `src/flow/plan.ts:81` `createHash('sha256').update(canonicalJson(plan),'utf8').digest('hex')`; node:crypto only |
| 12 | A single ~100-line execution combinator (one fold, `runFlow`) is the sole execution path | verified | `src/flow/run.ts:1-2` header "runFlow — the single execution combinator (the fold)"; `export const runFlow` at run.ts:108 |
| 13 | The fold replaced three divergent hand-written compositions whose page-lifecycle scoping had drifted; divergence now structurally inexpressible | verified | commit `5ca57ed` ("delete the three legacy compositions; runFlow is the only path"); grep returns only past-tense comments for the three symbols |
| 14 | Golden step-traces recorded from the three real legacy compositions BEFORE deletion | verified | commit `55e5064` ("record legacy step traces as committed golden fixtures") is a git ancestor of deletion commit `5ca57ed`; fixtures in `src/server/__tests__/__fixtures__/trace-golden/` |
| 15 | Conformance harness asserts the fold reproduces the goldens byte-for-byte across happy + every failure path (anti-renaming) | verified | `src/server/__tests__/trace-conformance.test.ts` (deep-compare `toEqual` against goldens; failure paths PAYMENT_BYPASS_NOT_PROVEN, failed_pre_submit, reconcile_required, REST guard) |
| 16 | Harness additionally pins expected traces inline so a corrupted golden can't mask a broken fold | verified | `src/server/__tests__/trace-conformance.test.ts:510-511` ("Pin the literal expected trace too, so a golden corrupted to match a broken fold cannot slip through") + inline literal |
| 17 | At the deletion gate (bridge 0.7.0): deleted all three compositions; removed migration feature flag, kill switch, shadow-comparison mode; fold sole path | verified | `package.json` version 0.7.0; commit `5ca57ed` body; grep returns only past-tense comments for `BRIDGE_FLOW_RUNNER` / `parseBridgeFlowRunnerEnabled` / `recordFlowShadowComparison`; Linear TIN-2093 Done |
| 18 | Deletion-gate change: 538 insertions against 1,305 deletions across 16 files | verified | `git show --stat 5ca57ed` = "16 files changed, 538 insertions(+), 1305 deletions(-)" — exact match |
| 19 | Each flow carries its own typed effect-requirement (R) channel; transport-agnosticism is a compile-time property | verified | `src/flow/flow.ts` `FlowBuilder<Spec, Provided, E, R>`; `docs/design/flow-dag-formalization.md:496-500` |
| 20 | Read-only CalCom REST adapter reuses the identical availability-flow definitions over an HTTP client | verified | `src/adapters/calcom/flows.ts:40,52` flowIds `availability_dates_refresh` / `availability_slots_refresh` IDENTICAL to Acuity (`src/adapters/acuity/flows.ts:93,105`); `src/adapters/calcom/flow-steps.ts` runs over `CalComHttpClient` |
| 21 | Source-level type fence proves CalCom steps never demand a browser service or scope, so a REST flow provisions no browser layer | verified | `src/adapters/calcom/r-channel-proof.ts` is a SOURCE module enforced by the `//:typecheck` tsc gate; type-level assertions prove `Exclude<R,BrowserService>==R`, `Exclude<R,Scope>==R`, `R` is exactly `CalComHttpClient` |
| 22 | Two distinct adopter applications consume the stack end-to-end and auth-free: one kit+bridge, a second kit alone | verified (framing) | Linear TIN-2035 Done; MassageIthaca PR #478 (kit 0.9.1 + bridge 0.7.0); software.tinyland.dev-booking PR #11 (kit alone). **Both adopters are operator-affiliated and each adopter's live production is gated behind a manual promote — abstract says "consume end-to-end", NOT "in production", so it stays accurate.** |
| 23 | Both adopters pull packages from committed vendored tarballs built from a single Bazel package artifact (not an authenticated registry); removes per-consumer credential plumbing from CI / container builds / dependency automation | verified | PR #478 (`vendor/*.tgz` from Bazel `//:pkg`, `scripts/vendor-scheduling.sh`, `.npmrc -1`, Dependabot/Docker/CI token-free); PR #11 (`file:./vendor/...tgz`, no GitHub Packages token); `BUILD.bazel` `//:pkg`; doctrine `docs/build-and-release.md` |
| 24 | Vendor selectors de-tenanted into per-tenant data so shared automation never names a tenant | verified | commit `f27e3ff` ("selector de-tenanting"); `src/adapters/acuity/selector-registry.ts` BaseSelectors vendor-neutral, per-tenant chains merged via `buildSelectors(profile)` |
| 25 | Dual-path migration window capped to a single minor release, closed with recorded-trace conformance | verified | flag flipped ON in 0.6.1 (`bf148b4`); deleted at 0.7.0 gate (`5ca57ed`). Window = single minor (0.6.1 → 0.7.0); closed by the trace-conformance harness |
| 26 | Deletion gate retires the bridge's internal divergent compositions + dual-path runtime flag, NOT the vendor relationship; more browser vendors + full app-level sunset are future work | verified (scoping) | `docs/design/flow-dag-formalization.md` (GlossGenius = vendor #2 in 0.8.0, Vagaro deferred); application-level Acuity-vs-homegrown cutover lives in MassageIthaca, not this repo |

**Preserved real numbers (unchanged from the existing paper, all
verified, no contradictions in-repo):** 604 appointments verified, 62
weeks of historical calendar data, 8 blocked REST endpoints, production
since March 2026, 17-method adapter interface.

**Open OPERATOR-VERIFY items (inline in `docs/paper.md`):**

1. Bridge-internal strangler (flow-runner flag) is deleted in 0.7.0; the
   application-level `SCHEDULING_BACKEND` selector (in the MassageIthaca
   app) is a separate axis whose full Acuity sunset remains future work.
2. Deployment substrate specifics (RKE2, 4 replicas, tailnet-only, Node
   24) drawn from the design doc + Dockerfile on main — confirm before
   camera-ready.
3. Both adopters are operator-affiliated and each adopter's live
   production is behind a manual promote; "consume the stack end-to-end"
   is accurate, "in production" for the adopters is not yet.
4. Data Availability Statement DOI (required by ASE 2026) — confirm a real
   archived DOI before submission.
