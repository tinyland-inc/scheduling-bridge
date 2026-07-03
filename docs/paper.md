# Typed Browser Automation as an Anti-Corruption Layer: A FOSS Offramp Pattern for SaaS Vendor Lock-in

**Jess Sullivan**
Tinyland Inc.

---
[acuity-middleware-paper.tex](paper/acuity-middleware-paper.tex)
## Abstract

Small-business SaaS scheduling platforms create vendor lock-in through API paywalls and proprietary data formats, leaving owner-operators unable to read or move their own appointment data without paying for an API tier. This experience report describes a typed browser-automation anti-corruption layer (ACL) that we ran in production for a real massage-therapy practice, and the software-engineering practice of carrying it from a feature-flagged migration to a completed, deleted-legacy system. The architecture separates a vendor-neutral contract -- a 17-method scheduling adapter interface, every method returning a monadic Effect for composable, typed error handling -- into a standalone library (`scheduling-kit`), while vendor-specific automation lives in a separate adapter hub (`scheduling-bridge`); each locked-in backend gets its own adapter package, giving small businesses a reusable FOSS offramp. The shipped browser backend (Acuity) replaces 8 REST endpoints that are blocked behind the vendor's paid API tier, driving them through headless DOM automation against a React single-page app alone. The middleware has run in production since March 2026 (now on a self-hosted Kubernetes cluster, having migrated off the original serverless substrate consuming the same container artifact), validated by a one-time campaign that automated 604 legacy appointments across 62 weeks of historical calendar data.

The engineering contribution is how we modeled and then retired the ACL with evidence rather than faith. Each booking flow is authored once as typed effect definitions, and a serializable flow DAG -- a FlowPlan carrying a sha256 content hash -- is derived as a projection of the very definitions that execute, never as a second, hand-maintained source of truth. A single ~100-line execution combinator (one fold over the derived plan) replaced three divergent hand-written booking compositions whose page-lifecycle scoping had quietly drifted apart; that divergence is now structurally inexpressible. To migrate without trusting the rewrite, we recorded golden step-traces from the three real legacy compositions before deleting them, then made a conformance harness assert the fold reproduces those traces byte-for-byte across every happy and failure path -- an anti-renaming guarantee that the surviving path is behaviorally the old one, not a silent regression (the harness additionally pins the expected traces inline so a corrupted golden cannot mask a broken fold). At the deletion gate (released in bridge 0.7.0) we deleted all three legacy compositions, removed the migration feature flag, its kill switch, and its shadow-comparison mode -- a net change of 538 insertions against 1,305 deletions across 16 files -- leaving the fold as the sole code path. We treat that removal, not its existence, as the migration's success criterion: an ACL's promised temporariness discharged as a concrete, test-gated deletion event. Because each flow carries its own typed effect-requirement (R) channel, transport-agnosticism is a compile-time property rather than a hope: a read-only CalCom REST adapter reuses the identical availability-flow definitions over an HTTP client, and a source-level type fence proves its steps never demand a browser service or scope, so a REST flow provisions no browser layer. Two distinct adopter applications now consume the stack end-to-end and authentication-free -- one consuming both the kit and the bridge, a second the kit alone -- pulling the packages from committed, vendored tarballs built from a single Bazel package artifact rather than an authenticated registry, removing per-consumer credential plumbing from CI, container builds, and dependency automation. We discuss practical challenges honestly: the fragility of DOM automation against an evolving SPA; capping the dual-path migration window to a single minor release and closing it with recorded-trace conformance; de-tenanting vendor selectors into per-tenant data so shared automation never names a tenant; and the limits of the result -- the deletion gate retires the bridge's internal divergent compositions and its dual-path runtime flag, not the vendor relationship itself, with additional browser-backed vendors and full application-level vendor sunset remaining future work. The lesson for practitioners is that capturing behavior as golden traces before deletion converts "delete the strangler" from a leap of faith into a verifiable engineering step, and that a typed anti-corruption layer can give small businesses a credible, deployed exit from proprietary scheduling services.

---

## I. Introduction

The modern small business operates on a stack of vertical SaaS products: scheduling, payments, email marketing, inventory, point-of-sale. Each product captures business data in proprietary formats behind vendor-controlled APIs. When the relationship sours -- pricing changes, feature regression, acquisition, or simple neglect -- the business discovers that migration is not a product feature. It is an engineering problem, and one the vendor has no incentive to solve.

Acuity Scheduling, a Squarespace subsidiary, exemplifies this dynamic. The platform provides appointment booking for service businesses (massage therapy, consulting, tutoring) via an embeddable iframe widget and a web-based admin panel. The REST API that would enable programmatic access to appointment data, availability, and booking operations is gated behind the "Powerhouse" plan -- a pricing tier that returns HTTP 403 on all endpoints for lower-tier accounts [1]. The business's own appointment history, client records, and scheduling configuration are accessible only through the web UI.

This paper presents a middleware architecture that solves the migration problem through browser automation. Rather than reverse-engineering the vendor's internal APIs or negotiating for API access, the system drives the vendor's public-facing booking wizard via headless Playwright [2], translating standardized adapter method calls into sequences of DOM interactions. The middleware ships as a single container artifact; it originally ran serverless on Modal Labs [3] and production has since migrated to a self-hosted Kubernetes (RKE2) cluster consuming the same artifact, with Modal retained as a legacy proofing surface.

The key insight is that browser automation middleware is not the destination -- it is the bridge. The architecture implements the strangler fig pattern [4]: at the application level a backend selector routes scheduling operations to either the legacy vendor (via browser automation) or a homegrown PostgreSQL backend (via direct queries), and inside the bridge a feature-flagged migration carried each booking flow from three divergent hand-written compositions onto a single derived-plan fold. That bridge-internal migration is now complete: at a test-gated deletion gate (bridge 0.7.0) the three legacy compositions, the migration feature flag, its kill switch, and its shadow-comparison mode were deleted, leaving the fold as the sole execution path. The adapter interface ensures that consumers of scheduling operations are completely isolated from which backend serves them. <!-- OPERATOR-VERIFY: the bridge-internal strangler (runtime flow-runner flag) is deleted in 0.7.0; the application-level Acuity-vs-homegrown selector (SCHEDULING_BACKEND, in the MassageIthaca app) is a separate axis whose full Acuity sunset remains future work. -->

A central contribution of this report is how that deletion was made safe. The booking flow is authored once as typed effect definitions, and the flow DAG is a serializable projection (a `FlowPlan` carrying a sha256 content hash) derived from the very definitions that execute -- there is no second, hand-maintained source of truth and no JSON authoring front door. Before deleting the legacy compositions we recorded golden step-traces from them; a conformance harness then asserts the fold reproduces those traces byte-for-byte across every happy and failure path, so the surviving fold is provably the old behavior rather than a silent rename.

### Contributions

This paper makes the following contributions:

1. A formal 17-method `SchedulingAdapter` interface that abstracts scheduling operations (services, providers, availability, advisory soft holds, bookings, clients) across heterogeneous backends, with all methods returning monadic `Effect<T, SchedulingError>` for composable, typed error handling.

2. An adapter hub architecture (`scheduling-bridge`) that separates the interface definition from vendor-specific implementations, enabling multiple SaaS backends to be wrapped as discrete packages -- a reusable FOSS offramp pattern for small businesses escaping proprietary scheduling services.

3. An Effect TS browser automation layer that implements the adapter interface via headless Playwright, using typed effect programs for each wizard step, managed browser lifecycle via `acquireRelease`, and a CSS selector registry with fallback chains for resilience against DOM instability.

4. A flow DAG modeled as a *derived projection*: each booking flow is authored once as typed effect definitions, and a serializable `FlowPlan` (carrying a sha256 content hash) is derived from -- never authored alongside -- the definitions that execute, run by a single ~100-line fold that replaced three divergent hand-written compositions whose page-lifecycle scoping had drifted apart.

5. An *anti-renaming* deletion gate: golden step-traces recorded from the three real legacy compositions before deletion, a conformance harness asserting the fold reproduces them byte-for-byte across every happy and failure path (with the expected traces pinned inline so a corrupted golden cannot mask a broken fold), and the resulting test-gated removal of the legacy compositions, the migration feature flag, its kill switch, and its shadow mode (538 insertions against 1,305 deletions across 16 files) -- treating deletion, not existence, as the migration's success criterion.

6. Compile-time transport-agnosticism via per-flow effect-requirement (R) typing: a read-only CalCom REST adapter reuses the identical availability-flow definitions over an HTTP client, and a source-level type fence proves its steps never demand a browser service or scope, so a REST flow provisions no browser layer.

7. Production deployment evidence from a real massage therapy practice -- reliability data from 604 automated legacy appointment operations -- and a demonstrated reusable offramp: two distinct adopter applications now consume the stack end-to-end and authentication-free (one consuming both the kit and the bridge, a second the kit alone) from committed, vendored tarballs built from a single Bazel package artifact.

---

## II. Related Work

### A. Legacy System Modernization

The Carnegie Mellon Software Engineering Institute taxonomy [5] classifies modernization strategies along a spectrum from wrapping (black-box, no source access) to reengineering (white-box, full source transformation). Browser automation middleware is a form of black-box wrapping -- the legacy system's UI is the only interface analyzed. Seacord et al. [6] formalize the risk-managed approach to modernization, emphasizing incremental strategies that preserve system availability during transition. Our feature-flag approach implements their recommended "parallel operation" phase.

### B. Wrapper-Based Evolution

Sneed [7] proposes wrapping legacy information systems with service-oriented interfaces, treating the wrapper as a translation layer between modern consumers and legacy implementations. Rahgozar and Oroumchian [8] identify three design patterns for wrapper interfaces: Lowest Common Denominator, Most Popular, and Negotiated. Our `SchedulingAdapter` interface follows the Negotiated pattern -- the 17 methods represent the intersection of capabilities needed by the application, not the full surface area of any single backend.

Prior wrapper work focused on mainframe terminal interfaces (3270 screen scraping) and COBOL API wrapping [5]. This work wraps a modern React single-page application rendered with Emotion CSS-in-JS -- a qualitatively different challenge where DOM structure is dynamic, CSS class names are hash-unstable, and user interactions trigger asynchronous client-side state transitions rather than synchronous server round-trips.

### C. The Strangler Fig Pattern

Fowler [4] describes the strangler fig pattern as a metaphor for incremental system replacement: new functionality is built alongside the old system, with a routing layer that progressively shifts traffic from legacy to replacement. Newman [9] applies the pattern to microservice migration. Our `resolveBackend()` function is the routing facade, checking environment variables and hostname to select between the Acuity wizard adapter (legacy) and the homegrown PostgreSQL adapter (replacement).

### D. Anti-Corruption Layer

Evans [10] defines the Anti-Corruption Layer as a pattern for isolating a bounded context from the domain model of an external system. The `SchedulingAdapter` interface serves this role: it prevents Acuity's domain concepts (appointment type IDs, React wizard steps, Square payment integration) from leaking into the homegrown domain model (UUID-based services, advisory soft holds, Stripe/Venmo payments). The dual-ID resolution pattern in the homegrown adapter -- accepting both UUID and legacy `acuityId` -- is an explicit corruption-containment mechanism.

### E. Robotic Process Automation

Van der Aalst et al. [11] survey Robotic Process Automation as an enterprise paradigm for automating UI-level business processes. The 2024 IEEE survey by Lasso-Rodriguez et al. [12] extends this analysis across industry verticals. A systematic mapping study by Enriquez et al. [24] found a "relative lack of attention to RPA in the academic literature" contrasting with "early practical adoption of RPA in industry." Our work shares the automation-of-UI-interaction philosophy but differs in three ways: (a) typed interfaces with monadic error handling replace low-code bot builders, (b) the automation target is a third-party SaaS UI rather than an internal enterprise application, and (c) the automation is explicitly designed to be temporary -- a bridge to a replacement backend, not a permanent integration layer.

Dong et al. [25] formalize web-based RPA in WebRobot (PLDI 2022), proposing a program synthesis algorithm for automating browser interactions. Evaluated on 76 benchmarks, WebRobot demonstrates the feasibility of treating browser automation as a programming language construct. Our work differs in using hand-written Effect TS programs rather than synthesized scripts, trading generality for the type-level guarantees needed in a production scheduling system.

### F. SaaS Vendor Lock-in

Alhamazani et al. [13] and Opara-Martins et al. [14] provide decision frameworks for assessing and mitigating SaaS vendor lock-in across API, data, and contract dimensions. Our work is a concrete case study of the scenario they describe: API access restricted by pricing tier, data accessible only through vendor UI, and no standard export mechanism for appointment history or client records.

### G. Containerized Browser Runtimes

Running headless browsers in serverless environments requires careful resource management. The `@sparticuz/chromium` project [15] provides a stripped Chromium binary for AWS Lambda's 50MB deployment constraint. Microsoft's Playwright Docker images [16] provide pre-configured containers with all browser dependencies.

The choice of container runtime significantly impacts browser automation viability:

| Platform | Max Package Size | Max Memory | Max Timeout | Chromium Support |
|----------|-----------------|------------|-------------|-----------------|
| Modal Labs | No practical limit (FUSE lazy-load) | Configurable | No hard limit | Native via `playwright install` |
| AWS Lambda | 50 MB zipped / 250 MB uncompressed | 10 GB | 15 min | Requires @sparticuz/chromium |
| Vercel Functions | 50 MB | 1-3 GB | 10-900s | Impractical at size limits |

Modal's architecture uses a FUSE-based lazy-loading filesystem [26] that treats container images as an index (~5 MB of metadata), loading file contents on demand. This eliminates size constraints that make Lambda and Vercel problematic for browser workloads. Modal's gVisor-based isolation [27] provides a userspace kernel boundary appropriate for running untrusted browser content, and memory snapshots enable sub-3-second cold starts even with heavy dependencies.

### H. iframe Deprecation

The embedded iframe remains the dominant integration mechanism for SaaS scheduling widgets [28]. However, third-party cookie deprecation in modern browsers increasingly breaks iframe-based authentication, resulting in blank screens or non-functional login prompts [29]. Approximately one-third of all breaches in 2024 were third-party related, with iframes serving as a primary attack vector [30]. The migration from iframe embedding to native UI components -- documented by Cloudbeds as yielding 20-30% higher conversion rates [31] -- represents the broader industry context motivating this work.

---

## III. System Design

### A. Architecture Overview

The system is distributed across three repositories, each with a distinct role:

| Repository | npm Package | Role |
|---|---|---|
| `scheduling-kit` | `@tummycrypt/scheduling-kit` | Interface definition, homegrown PostgreSQL adapter, payment adapters, Svelte UI components |
| `scheduling-bridge` | `@tummycrypt/scheduling-bridge` | Adapter hub: vendor-specific automation (Acuity via Playwright, future CalCom/GlossGenius) |
| `MassageIthaca` | (application) | Backend selector, admin UI, booking pages |

This separation enforces a key architectural principle: the adapter interface and the native replacement backend live in one package, while each vendor automation adapter lives in a separate package. Adding a new SaaS backend adapter means adding a new package to `scheduling-bridge` -- no changes to the interface or the application.

The system consists of four layers:

**Consumer Layer.** SvelteKit [17] API routes (`/api/schedule/*`) and admin pages that invoke scheduling operations through the adapter interface. Consumers are completely backend-agnostic.

**Routing Layer.** The `resolveBackend()` function selects a backend based on environment variables (`SCHEDULING_BACKEND`) and branch-level overrides (the `dev/main` branch forces Acuity for beta stability). The `getSchedulingKit()` singleton factory instantiates the selected adapter and wraps it with a `PaymentRegistry` for payment processor composition.

**Adapter Layer.** Five concrete implementations of the `SchedulingAdapter` interface, spanning both packages:
- `HomegrownAdapter` (scheduling-kit): Direct PostgreSQL queries via Drizzle ORM against Neon serverless
- `AcuityWizardAdapter` (scheduling-bridge): Effect TS browser automation via Playwright
- `AcuityScraperAdapter` (scheduling-bridge): Read-only BUSINESS object extraction for service/availability data
- `RemoteWizardAdapter` (scheduling-bridge): HTTP proxy to a remote middleware server on Modal Labs
- `CalComAdapter` (scheduling-kit): Stub for potential future migration (all methods return NOT_IMPLEMENTED)

**Browser Automation Layer.** Effect TS programs that drive individual wizard steps (navigate, fill form, bypass payment, submit, extract confirmation), managed by a `BrowserService` layer that handles Playwright lifecycle via `acquireRelease`. These live in `scheduling-bridge/src/adapters/acuity/`, establishing the pattern for future vendor adapters.

### B. The SchedulingAdapter Interface

The interface defines 17 methods across six categories:

```typescript
interface SchedulingAdapter {
  readonly name: string;
  // Services (2)
  getServices(): SchedulingResult<Service[]>;
  getService(id: string): SchedulingResult<Service>;
  // Providers (3)
  getProviders(): SchedulingResult<Provider[]>;
  getProvider(id: string): SchedulingResult<Provider>;
  getProvidersForService(id: string): SchedulingResult<Provider[]>;
  // Availability (3)
  getAvailableDates(p: DateParams): SchedulingResult<AvailableDate[]>;
  getAvailableSlots(p: SlotParams): SchedulingResult<TimeSlot[]>;
  checkSlotAvailability(p: CheckParams): SchedulingResult<boolean>;
  // Advisory soft holds (2)
  softHoldSlot(p: SoftHoldParams): SchedulingResult<SlotSoftHold>;
  releaseSoftHold(id: string): SchedulingResult<void>;
  // Bookings (5)
  createBooking(req: BookingRequest): SchedulingResult<Booking>;
  createBookingWithPaymentRef(req, ref, proc): SchedulingResult<Booking>;
  getBooking(id: string): SchedulingResult<Booking>;
  cancelBooking(id: string, reason?: string): SchedulingResult<void>;
  rescheduleBooking(id: string, newDatetime: string): SchedulingResult<Booking>;
  // Clients (2)
  findOrCreateClient(c: ClientInfo): SchedulingResult<ClientInfo>;
  getClientByEmail(email: string): SchedulingResult<ClientInfo | null>;
}
```

All methods return `SchedulingResult<T>`, defined as `Effect<T, SchedulingError>` from Effect TS [19]. The `SchedulingError` type is a discriminated union with seven variants (`AcuityError`, `CalComError`, `PaymentError`, `ValidationError`, `ReservationError`, `IdempotencyError`, `InfrastructureError`), each carrying a `_tag` discriminant, a `code` string, and a human-readable `message`. (An earlier version used fp-ts [18] `TaskEither` for this type; this was replaced during a full unification migration to Effect.)

This design forces all error handling to be explicit at the type level. Consumers cannot accidentally ignore errors -- they must handle the error channel to access the success value. The `Effect` type enables lazy evaluation and composition via `pipe`, `map`, and `flatMap`.

### C. Unified Effect TS Architecture

The system uses Effect TS [19] as its sole functional programming library, providing a unified abstraction across all layers. Effect manages the browser middleware layer -- generator-based programs (`Effect.gen(function* () { ... })`), typed errors via `Data.TaggedError`, dependency injection via `Context.Tag`, and resource lifecycle management via `Layer.scoped` and `Effect.acquireRelease` -- and also provides the adapter interface return type (`Effect<T, SchedulingError>`) and composition operators (`pipe`, `map`, `flatMap`) used by consumers and the booking pipeline.

An earlier version used a dual-library approach: fp-ts [18] for the adapter interface (`TaskEither`) and Effect TS for the browser middleware, with a `runEffect` bridge function converting between the two by running Effect to an `Exit` value and mapping `Success` to `Right` and typed `Failure` to `Left`. This bridge was eliminated during a full unification migration to Effect.

### D. CSS Selector Registry

The Acuity booking wizard is a React SPA using Emotion CSS-in-JS, which generates hash-based class names (e.g., `css-1a2b3c4`) that are unstable across deployments. The selector registry (`Selectors`) maps 30+ logical names to arrays of CSS selector candidates, tried in order:

```typescript
const Selectors = {
  serviceList: [
    '.select-container .select-item',
    '[class*="service-list"] [class*="service-item"]',
    '.appointment-type-list .appointment-type',
  ],
  submitButton: [
    'button[type="submit"]:not([disabled])',
    'button.btn-primary:not([disabled])',
    '[data-testid="submit-booking"]',
    // ... 5 more fallbacks
  ],
  // ... 28 more keys
};
```

The `resolveSelector` function tries each candidate with a configurable timeout, returning the first match. The `probeSelector` variant returns `null` instead of failing, used for optional UI elements. This fallback-chain pattern provides resilience against minor DOM restructuring while maintaining the expectation that major UI redesigns will require registry updates.

---

## IV. Implementation

### A. Wizard Step Programs

The booking creation flow is implemented as seven Effect programs, each targeting a distinct phase of the Acuity wizard:

1. **Navigate** (~550 LOC). Loads the service selection page, matches the target service by name, clicks "Book," navigates the react-calendar to the target month (up to 12 iterations), clicks the target day tile, selects the time slot, and clicks "Select and continue." The calendar month detection parses label text with the regex `([A-Za-z]+)\s*(\d{4})` to handle whitespace variation. Day tiles are filtered by checking for the `neighboringMonth` CSS class and the `disabled` property.

2. **Fill Form** (~410 LOC). Fills standard client fields (`firstName`, `lastName`, `email`, `phone`) using `input[name="client.X"]` selectors with smart-fill (checks current value, skips if correct). Handles React-controlled intake radio buttons that lack `name` or `id` attributes by clicking `<label>` elements via Playwright's `locator().nth()` API, dispatching OS-level mouse events that React's event delegation processes. Fills medication textarea and terms checkbox.

3. **Bypass Payment** (226 LOC). Clicks the "Package, gift, or coupon code" toggle, enters a 100% gift certificate code from the `ACUITY_BYPASS_COUPON` environment variable, clicks "Apply," and verifies the discount was applied by checking for "Gift certificate" text and a "-$" indicator. This decouples scheduling from Acuity's Square payment integration -- actual payment is handled externally via Stripe, Venmo, or cash.

4. **Submit** (168 LOC). Clicks "PAY & CONFIRM" (8 fallback selectors) and polls for confirmation using three detection methods: CSS selectors (`.confirmation`, `.booking-confirmed`, etc.), URL pattern matching (`/(confirmation|confirmed|thank-you|complete)/i`), and body text searching ("booking confirmed", "appointment confirmed"). Polls every second for up to 60 seconds. Retries once with 2-second backoff on transient navigation failures.

5. **Extract** (174 LOC). Scrapes confirmation data (confirmation code, service name, datetime) from the confirmation page using regex patterns, maps to the `Booking` domain type.

6. **Read Availability** (399 LOC). Navigates to a service's calendar and reads enabled tiles to determine available dates. Multi-month scanning supported via prev/next navigation.

7. **Read Slots** (405 LOC). Clicks a specific date tile and reads `button.time-selection` elements. Slot text concatenates time and availability ("10:00 AM1 spot left") -- the regex `^(\d{1,2}:\d{2}\s*[AP]M)` extracts the time prefix.

### B. BrowserService Layer

The `BrowserService` is an Effect `Context.Tag` providing managed Playwright resources:

```typescript
class BrowserService extends Context.Tag('BrowserService')<
  BrowserService, BrowserServiceShape
>() {}
```

The live implementation uses two nested `acquireRelease` pairs: the outer pair manages the browser process (launch on acquire, close on release), the inner pair manages the page instance. Both are scoped to the `Layer` lifetime. When any wizard step program fails -- selector timeout, navigation error, coupon rejection -- the scope unwinds and both resources are released in reverse order.

### C. Deployment: from Serverless to a Self-Hosted Cluster

The middleware ships as a single container artifact and has run on two substrates. It originally deployed on Modal Labs [3] using the official Playwright Docker image as a base; production has since migrated to a self-hosted Kubernetes (RKE2) cluster consuming the same artifact, with Modal retained as a legacy proofing/fallback surface. The container configuration:

- **Image**: `mcr.microsoft.com/playwright:v1.58.2-noble` with Node.js 24 LTS
- **Resources**: 2 CPU cores, 2048 MB memory, no GPU
- **Concurrency**: `max_inputs=3` per container (each request gets an isolated browser context)
- **Scaling**: warm-pool latency reduction on Modal; horizontally-replicated pods (4 replicas, tailnet-only) on the Kubernetes cluster
- **Timeout**: 300 seconds (wizard flows take 15-60 seconds depending on operation)
- **Build authority**: the package is built from a single Bazel `//:pkg` artifact; the Docker image and the Kubernetes deployment both consume that derived package and the `dist/server/handler.js` entrypoint <!-- OPERATOR-VERIFY: substrate details (RKE2, 4 replicas, tailnet-only, Node 24) drawn from docs/design/flow-dag-formalization.md and Dockerfile on main; confirm before camera-ready. -->

The `max_inputs=3` concurrency allows multiple browser sessions per container, each with an isolated browser context. The runtime horizontally scales by spawning additional containers (Modal) or pods (Kubernetes) when all contexts in a container are occupied. The per-container concurrency was increased from `max_inputs=1` after production profiling showed that container cold starts dominated latency more than memory contention.

### D. Feature-Flag Backend Selection

The `resolveBackend()` function implements a priority chain:

```typescript
function resolveBackend(): 'acuity' | 'homegrown' {
  if (env.VERCEL_GIT_COMMIT_REF === 'dev/main') return 'acuity';
  return (env.SCHEDULING_BACKEND as 'acuity' | 'homegrown') ?? 'acuity';
}
```

The hostname override (`dev/main` forces Acuity) prevents accidental homegrown exposure on the beta environment while the alpha environment (`dev/*` branches) runs the homegrown backend. This implements a two-phase migration: shadow reads on alpha, then full cutover when the homegrown backend reaches feature parity.

### E. The Homegrown Replacement

The `HomegrownAdapter` implements all 17 `SchedulingAdapter` methods via direct PostgreSQL queries through Drizzle ORM [20] against Neon serverless [21]. Key design decisions:

- **Lazy database connection**: The adapter receives a `getDb` factory function, called per-operation. This avoids import-time connections critical for Vercel cold starts.
- **Lazy schema imports**: Drizzle schema tables are dynamically imported inside each method, preventing the ORM runtime from being bundled into client-side code.
- **Dual-ID resolution**: `resolveService` accepts both UUID (homegrown) and integer `acuityId` (legacy) via UUID format detection, enabling backward compatibility during migration.
- **Advisory soft holds**: PG-persisted with `expires_at`, unlike the wizard adapter which cannot support advisory soft holds through the public UI. Correctness still comes from the final booking write plus backend rejection, not from treating a hold as a reservation.

### F. Availability Engine

The availability engine is a pure-function module with zero database dependency. All data is passed as arguments. The core algorithm generates candidate slots at configurable intervals within business hours, filters out those overlapping with occupied blocks (bookings + time blocks + active soft holds), applies buffer time and minimum advance notice constraints. DST safety is achieved via `Intl.DateTimeFormat` with named timezones -- no manual offset tables. The module has 39 dedicated unit tests.

---

## V. Evaluation

### A. Legacy Automation Campaign

The browser automation layer was validated through a checkout automation campaign against 62 weeks of historical calendar data:

| Metric | Value |
|--------|-------|
| Appointments verified | 604 |
| Marked as paid | ~245 |
| Discounts applied | 10 (Liz Hartman, $100 to $70) |
| Price corrections | 2 (sticky panel bug remediation) |
| Circuit breaker aborts | 0 (after bug fixes) |
| Wrong-panel safety catches | 3 (all caught, corrected) |

The "sticky panel" bug -- where the Acuity admin panel's React state management exhibited a race condition causing the wrong appointment's data to persist in the detail form -- was discovered during this campaign. The remediation required three changes: explicit DOM removal waits on panel close, form action URL verification on panel open, and dual pre/post verification in all action functions.

### B. Test Coverage

| Component | Tests | Coverage Focus |
|-----------|-------|---------------|
| Scheduling-kit (core) | 555 | Adapter interface, pipeline composition, payment integration |
| Availability engine | 39 | Slot generation, DST, overlap detection, buffer time, edge cases |
| Adapter bridge | 3 | Backend selection, ID resolution |
| Application (root) | 282 | Route handlers, form validation, component rendering |
| **Total** | **879** | |

### C. Performance Characteristics

| Operation | Browser Middleware | Homegrown (PG) | Speedup |
|-----------|-------------------|----------------|---------|
| Get services | ~8s (DOM scrape) | <50ms | ~160x |
| Get available dates | ~15-20s (wizard nav) | <100ms | ~150-200x |
| Get time slots | ~15-20s (wizard nav) | <100ms | ~150-200x |
| Create booking | ~30-60s (full wizard) | <200ms | ~150-300x |

The browser middleware latency is acceptable only as a migration bridge. The two-order-of-magnitude performance gap underscores the importance of the strangler fig approach: the browser path exists to maintain service continuity during migration, not as a permanent architecture.

### D. Adapter Interface Coverage

| Category | Methods | Wizard Adapter | Homegrown Adapter |
|----------|---------|----------------|-------------------|
| Services | 2 | 2/2 | 2/2 |
| Providers | 3 | 3/3 (hardcoded) | 3/3 |
| Availability | 3 | 3/3 | 3/3 |
| Advisory soft holds | 2 | 0/2 (graceful fail) | 2/2 |
| Bookings | 5 | 2/5 | 5/5 |
| Clients | 2 | 2/2 (pass-through) | 2/2 |
| **Total** | **17** | **12/17** | **17/17** |

The wizard adapter's incomplete coverage (no `getBooking`, `cancelBooking`, `rescheduleBooking`, advisory soft holds) reflects the limitations of the public booking UI -- these operations require admin panel access. The homegrown adapter's full coverage demonstrates feature parity.

---

## VI. Discussion

### A. The Fragility Trade-off

Browser automation against a third-party SPA is inherently fragile. Acuity can change their React component structure, Emotion CSS class naming, or wizard flow at any time, breaking the selector registry. Three mitigations make this acceptable:

1. **Isolation via adapter interface.** Only the wizard adapter breaks -- all consumers continue to function via the homegrown backend.
2. **Disposability by design, demonstrated.** The wizard adapter is a migration bridge whose temporariness we discharged concretely: inside the bridge, the three divergent hand-written booking compositions and the migration feature flag were deleted at a test-gated deletion gate (0.7.0), leaving the single derived-plan fold as the only path. The application-level Acuity-vs-homegrown cutover -- deleting the browser middleware layer entirely once the homegrown backend reaches full feature parity -- remains future work.
3. **Fallback chains.** The selector registry tries multiple candidates per logical element, absorbing minor DOM restructuring without code changes.

### B. Effect Unification

An earlier version of the system used both Effect TS and fp-ts simultaneously, requiring a `runEffect` bridge function that was a source of subtle bugs -- incorrectly handling `FiberFailure` wrappers or `Cause` trees could swallow typed errors. The dual approach emerged from the adapter interface (defined in fp-ts terms before the middleware layer was built) and the middleware layer (requiring Effect's resource management capabilities). The system was subsequently unified on Effect TS throughout, eliminating the bridge function and the fp-ts dependency entirely. This reduced the mental model required of contributors and eliminated an entire class of error-boundary bugs.

### C. Ethical and Legal Considerations

Automating a vendor's UI to access data the business owns raises ethical questions. The Terms of Service may prohibit automated access, even to one's own data. We note that the data being accessed -- appointment schedules, client contact information, business hours -- belongs to the business, not the vendor. The automation accesses only the public booking wizard and the authenticated admin panel, never bypassing access controls. The coupon-based payment bypass is a legitimate use of Acuity's own gift certificate feature. Nevertheless, the approach should be understood as a temporary bridge during migration, not a permanent circumvention of vendor access controls.

### D. Generalizability: The FOSS Offramp Pattern

The architecture generalizes beyond a single vendor escape. The three-repo structure -- interface package, adapter hub, application -- establishes a reusable pattern we call the *FOSS offramp*:

1. **Define a domain-specific adapter interface** (`SchedulingAdapter`) in a standalone package (`scheduling-kit`). This interface becomes the anti-corruption layer contract.
2. **Implement a native FOSS backend** (`HomegrownAdapter`) in the same package, proving that the interface is sufficient for full functionality.
3. **Build vendor-specific adapters** in a separate adapter hub (`scheduling-bridge`), each wrapping a proprietary SaaS via browser automation, API scraping, or whatever mechanism the vendor permits.
4. **Route via strangler fig** -- the application's backend selector gradually shifts traffic from the vendor adapter to the native backend.

Each new vendor adapter gives another small business the same escape path. The Acuity adapter demonstrates the browser-automation pattern; a read-only CalCom REST adapter demonstrates that the *same* availability-flow definitions can run over a non-browser transport -- its steps demand only an HTTP client, and a source-level type fence proves they never demand a browser service or scope, so a REST flow provisions no browser layer. A GlossGenius adapter (browser-modality vendor #2) is planned future work. The offramp is also demonstrated at the consumer level: two distinct adopter applications now consume the stack end-to-end and authentication-free -- one consuming both the kit and the bridge, a second the kit alone -- pulling the packages from committed, vendored tarballs built from a single Bazel package artifact rather than an authenticated registry, removing per-consumer credential plumbing from CI, container builds, and dependency automation. The approach applies to any vertical SaaS category where small businesses accumulate data behind vendor-controlled interfaces: CRM, billing, inventory, email marketing, appointment scheduling. The key prerequisite is that the vendor's web UI must be automatable -- single-page applications with predictable DOM structure are more tractable than server-rendered pages with CSRF tokens and captchas. <!-- OPERATOR-VERIFY: both current adopters (MassageIthaca; software.tinyland.dev-booking) are operator-affiliated, and each adopter's live production is gated behind a manual promote; "consume the stack end-to-end" is accurate, "in production" for the adopters is not yet. -->

To keep shared automation genuinely vendor-neutral, tenant-specific selectors were de-tenanted into per-tenant selector-profile data, so the shared booking segments never name a tenant. Payment injection (the coupon-based bypass) is likewise a reusable first-class flow segment gated twice -- the vendor flow pack must declare it and the kit's capability model must admit it -- rather than a branch hard-coded into shared code.

The adapter hub uses Bazel as its build system, with each vendor adapter as a discrete build target (`:acuity_adapter`, future `:calcom_adapter`, `:glossgenius_adapter`). This enforces clean dependency boundaries between adapters and shared infrastructure (browser service, logging, remote proxy).

---

## VII. Conclusion

We have presented a typed browser automation architecture that functions as an anti-corruption layer for escaping SaaS vendor lock-in. The system separates the adapter interface (`scheduling-kit`, 17 methods) from vendor-specific automation (`scheduling-bridge`). Deployed in production since March 2026 -- initially on the Modal Labs serverless substrate and now on a self-hosted Kubernetes (RKE2) cluster consuming the same container artifact -- the system serves real appointment bookings against the locked-in vendor through DOM automation alone.

The engineering core of the report is that we modeled and then retired the ACL with evidence rather than faith. Each booking flow is authored once as typed effect definitions; a serializable flow DAG (a `FlowPlan` carrying a sha256 content hash) is derived as a projection of those same definitions, and a single ~100-line fold replaced three divergent hand-written compositions whose page-lifecycle scoping had drifted apart. Before deleting the legacy compositions we recorded golden step-traces from them, then made a conformance harness assert the fold reproduces those traces byte-for-byte across every happy and failure path. At the deletion gate (0.7.0) the three compositions, the migration feature flag, its kill switch, and its shadow mode were removed (538 insertions against 1,305 deletions across 16 files), leaving the fold as the sole code path. We treat that removal, not its existence, as the migration's success criterion.

More broadly, the architecture establishes a reusable FOSS offramp pattern: define a domain-specific typed interface, implement a native backend, and wrap each proprietary vendor as a separate adapter package. Per-flow effect-requirement typing makes transport-agnosticism a compile-time property -- a read-only CalCom REST adapter reuses the identical availability-flow definitions over an HTTP client without ever provisioning a browser layer. The three-repo structure (interface, adapter hub, application) and Bazel-based build system make adding new vendor adapters a matter of implementing the interface, not modifying the application; two distinct adopter applications already consume the stack end-to-end and authentication-free from committed, vendored Bazel-built tarballs. The lesson for practitioners is that capturing behavior as golden traces before deletion converts "delete the strangler" from a leap of faith into a verifiable engineering step.

The deletion gate retires the bridge's internal divergent compositions and its dual-path runtime flag, not the vendor relationship itself. Future work includes completing the application-level Acuity sunset, extending the adapter hub with additional browser-backed vendors (e.g. GlossGenius), automated service drift detection via reconciliation crons, and investigating AI-assisted selector maintenance for longer-lived browser automation deployments.

---

## References

[1] Acuity Scheduling, "API Access," *Acuity Scheduling Documentation*, 2026. [Requires Powerhouse plan for REST API access.]

[2] Microsoft, "Playwright: Fast and reliable end-to-end testing for modern web apps," 2025. [Online]. Available: https://playwright.dev/

[3] Modal Labs, "Modal: Run generative AI models, large-scale batch jobs, job queues, and much more," 2025. [Online]. Available: https://modal.com/

[4] M. Fowler, "StranglerFigApplication," *martinfowler.com*, Jun. 2004. [Online]. Available: https://martinfowler.com/bliki/StranglerFigApplication.html

[5] S. Comella-Dorda, K. Wallnau, R. Seacord, and J. Robert, "A Survey of Legacy System Modernization Approaches," Carnegie Mellon Univ., Software Eng. Inst., Pittsburgh, PA, Tech. Note CMU/SEI-2000-TN-003, 2000.

[6] R. C. Seacord, D. Plakosh, and G. A. Lewis, *Modernizing Legacy Systems: Software Technologies, Engineering Processes and Business Practices*. Boston, MA: Addison-Wesley, 2003.

[7] H. M. Sneed, "Wrapping legacy software for reuse in a SOA," in *Proc. Workshop on Legacy System Modernization*, 2006.

[8] M. Rahgozar and A. Oroumchian, "Design Patterns for Wrapping Similar Legacy Systems with Common Service Interfaces," *J. Syst. Softw.*, 2003.

[9] S. Newman, *Building Microservices*, 2nd ed. Sebastopol, CA: O'Reilly Media, 2021.

[10] E. Evans, *Domain-Driven Design: Tackling Complexity in the Heart of Software*. Boston, MA: Addison-Wesley, 2003.

[11] W. M. P. van der Aalst, M. Bichler, and A. Heinzl, "Robotic Process Automation," *Bus. Inf. Syst. Eng.*, vol. 60, no. 4, pp. 269-272, 2018.

[12] I. Lasso-Rodriguez et al., "Robotic Process Automation Applications Across Industries: An Exploration," in *Proc. IEEE Conf.*, 2024.

[13] O. Alhamazani et al., "A Holistic Decision Framework to Avoid Vendor Lock-in for Cloud SaaS Migration," 2017.

[14] C. Opara-Martins, R. Sahandi, and J. Tian, "A decision framework to mitigate vendor lock-in risks in cloud (SaaS category) migration," Bournemouth Univ., 2018.

[15] Sparticuz, "@sparticuz/chromium," GitHub, 2024. [Online]. Available: https://github.com/Sparticuz/chromium

[16] Microsoft, "Docker | Playwright," *playwright.dev*, 2025. [Online]. Available: https://playwright.dev/docs/docker

[17] Svelte Society, "SvelteKit," 2025. [Online]. Available: https://kit.svelte.dev/

[18] G. C. Scala, "fp-ts: Functional programming in TypeScript," GitHub, 2024. [Online]. Available: https://github.com/gcanti/fp-ts

[19] Effect Contributors, "Effect: The missing standard library for TypeScript," 2025. [Online]. Available: https://effect.website/

[20] Drizzle Team, "Drizzle ORM," 2025. [Online]. Available: https://orm.drizzle.team/

[21] Neon Inc., "Neon: Serverless Postgres," 2025. [Online]. Available: https://neon.tech/

[22] E. Gamma, R. Helm, R. Johnson, and J. Vlissides, *Design Patterns: Elements of Reusable Object-Oriented Software*. Reading, MA: Addison-Wesley, 1994.

[23] R. Khadka et al., "How do professionals perceive legacy systems and software modernization?," in *Proc. 36th Int. Conf. Softw. Eng. (ICSE)*, ACM, 2014.

[24] J. G. Enriquez, S. Jimenez-Ramirez, F. J. Dominguez-Mayo, and J. A. Garcia-Garcia, "Robotic Process Automation: A Scientific and Industrial Systematic Mapping Study," *IEEE Access*, vol. 8, pp. 39113-39129, 2020.

[25] X. Dong, Z. Chen, Y. Wen, and A. Cheung, "WebRobot: Web Robotic Process Automation using Interactive Programming-by-Demonstration," in *Proc. ACM SIGPLAN Conf. Programming Language Design and Implementation (PLDI)*, 2022.

[26] Modal Labs, "Fast, lazy container loading," *modal.com/blog*, 2024. [Online]. Available: https://modal.com/blog/jono-containers-talk

[27] Google, "gVisor: Container Runtime Sandbox," 2024. [Online]. Available: https://gvisor.dev/

[28] Acuity Scheduling, "Embeds and Dynamic Links," *Acuity Scheduling Developers*, 2026. [Online]. Available: https://developers.acuityscheduling.com/docs/embedding

[29] Smashing Magazine, "Reliably Detecting Third-Party Cookie Blocking In 2025," May 2025. [Online]. Available: https://www.smashingmagazine.com/2025/05/reliably-detecting-third-party-cookie-blocking-2025/

[30] Qrvey, "2026 Iframe Security Risks and 10 Ways to Secure Them," 2026. [Online]. Available: https://qrvey.com/blog/iframe-security/

[31] Cloudbeds, "iFrame Deprecation: Upgrade to Cloudbeds Booking Engine Plus," 2025. [Online]. Available: https://myfrontdesk.cloudbeds.com/hc/en-us/articles/42963882806299
