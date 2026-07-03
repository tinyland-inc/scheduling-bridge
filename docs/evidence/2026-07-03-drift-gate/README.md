# Drift gate — proving the trace-conformance comparator bites (TIN-1993 / TIN-2092)

**Date:** 2026-07-03 &nbsp;·&nbsp; **Repo:** `Jesssullivan/scheduling-bridge` &nbsp;·&nbsp;
**Branch:** `codex/tin-1993-drifted-golden` &nbsp;·&nbsp; **Base:** `origin/main @ fc1c328`

## What this closes

`src/server/__tests__/trace-conformance.test.ts` asserts the `runFlow` fold
**reproduces** 14 recorded goldens across happy paths, bypass-proof, pre-submit
failures, submit/post-submit reconcile, and retry. Before this change, nothing
proved the comparator would **reject** a wrong trace — every golden proof was
*unfalsified*. A comparator that accepted everything would have passed all of
them. `runFlow` is the sole execution path (TIN-2092 deletion gate), so this is
the guard on the guard.

## What is proven

1. **A deliberately-drifted committed fixture fails the SAME comparator path.**
   `src/server/__tests__/__fixtures__/trace-golden-drifted/happy-booking.json` is
   `trace-golden/happy-booking.json` with exactly three mutations:
   - **step id** — `acuity/navigate` → `acuity/navigate-DRIFTED`
   - **terminal status** — `succeeded` → `failed_pre_submit`
   - **scope grouping** — the `scope-open` before `acuity/submit` removed, so
     `submit` regroups into the `bypass-payment` page session (11 events vs 12).

   The new in-file test `drift gate (a)` produces the real fold trace exactly as
   the happy-path conformance test does (`runBookingTrace` → `makeExecutor`),
   confirms it is GREEN against the pristine golden via `toEqual`, then confirms
   the identical `expect(foldTrace).toEqual(...)` comparator REJECTS the drifted
   fixture, and pins the precise three-site diff.

2. **Every drift class fails the SAME comparator (parameterized meta-test).**
   `drift gate (b)` mutates loaded goldens **in memory** (deep-cloned; the 14
   on-disk goldens are never touched) across four classes — **step reorder**,
   **status flip**, **scope regroup**, **trace truncation** — over six
   booking-family goldens (24 cases), asserting `toEqual` throws for each.

The 21 existing conformance tests and 14 goldens are **unchanged** — the diff to
`trace-conformance.test.ts` is purely additive (see `git log`/`git diff`).

## Evidence files

- [`suite-green.txt`](./suite-green.txt) — `pnpm test` (Bazel `//:test`) full run:
  **65 files / 625 tests passed**, including `drift gate (a)` + all 24 `drift gate
  (b)` cases, plus the precise-diff console line the real gate emitted.
- [`drift-red-through-real-gate.txt`](./drift-red-through-real-gate.txt) — a
  throwaway demo (`expect(driftedTrace).toEqual(golden)`, uncommitted, since
  deleted) driving the drifted fixture through the real comparator: Bazel
  `//:test` **FAILED**, with the exact vitest diff naming all three drift sites.

## Reproduce

```sh
pnpm test    # node scripts/run-bazel-target.mjs test //:test — green

# the red is captured by the drift-gate (a) console line inside the green run;
# for a standalone red, point expect(trace).toEqual(golden) at
# __fixtures__/trace-golden-drifted/happy-booking.json and run pnpm test.
```
