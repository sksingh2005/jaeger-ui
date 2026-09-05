# First Step Report — Validated v3 Wire Contract

> LFX Term 3 — Jaeger UI is two-thirds through three interlocking migrations. This program finishes all three and deletes what they replaced. Week 1–2 deliverable: local wire capture, OpenAPI/schema audit, current-PR reproduction, contract-test design. This report records what was built locally, how it relates to open community PRs, and what remains gated.

Date: 2026-09-03 Branch: `main` + local schema-only changes (not yet pushed as PR) Upstream issue: [#4278](https://github.com/jaegertracing/jaeger-ui/issues/4278) / [#3265](https://github.com/jaegertracing/jaeger-ui/issues/3265) Phase 3.2 Evidence bundle: `lfx-term-3-evidence/fixtures/v3-trace-local-2.13.0.json`, `...-metadata.md`, `rich-otlp-probe.json`, `scripts/{capture,validate}-v3-trace.sh`

---

## 1. What we are trying to cover

**Pivotal step per `lfx-term-3-proposal.md:30` and `docs/rfc/0002-otel-native-jaeger-ui.md:491`:** loading a trace natively over `/api/v3/traces/{trace_id}` into the enriched `IOtelTrace` domain model, validated at the network boundary.

Earlier v3 integrations (services, operations, trace-summaries) consumed small flat Jaeger-defined messages where a generated schema was cheap. A full trace is the first payload that pulls the _entire_ OTLP model into the query layer: nested `resourceSpans/scopeSpans`, recursive `AnyValue` behind every attribute, events, links, status. Whether that model is generated and refined vs hand-written private wire types is the central judgement.

Everything is gated on it: once traces arrive as OTLP, `OtelTraceFacade`/`OtelSpanFacade` (`src/model/OtelTraceFacade.tsx`, `OtelSpanFacade.tsx`), `transformTraceData` (`src/model/transform-trace-data.ts`), legacy trace types (`src/types/trace.tsx`), and backend v1 HTTP handlers (`/api/traces`, `/api/transform`) lose their reason to exist. Performance is a hard constraint — 80,000 spans, iterative not recursive.

**Expected outcomes this step feeds** (`proposal: Expected outcomes`): native OTLP trace loading with visual/perf parity, legacy data path deleted, single `JaegerClient` surface, Redux fully removed, unified layout precedence — all blocked until the wire contract is locked.

---

## 2. What our local changes actually do (and do not do)

### 2.1 Changed files (schema-only, reversible)

```
knip.config.ts                           |  +4
packages/jaeger-ui/src/api/v3/client.ts  | +31
packages/jaeger-ui/src/api/v3/schemas.ts | +173
```

Plus two new test files (not yet in `main`):

```
packages/jaeger-ui/src/api/v3/schemas.trace-contract.test.ts  | 18 tests
packages/jaeger-ui/src/api/v3/client.trace-contract.test.ts   |  7 tests
```

### 2.2 `packages/jaeger-ui/src/api/v3/schemas.ts:36`

Generated file `generated-client.ts:168–243` already contains full OTLP Zod schemas (`opentelemetry_proto_trace_v1_Span:168`, `...Span_Event:144`, `...Span_Link:153`, `...Status:164`, `...TracesData:205`, `AnyValue:105`, etc) but every field is `.partial().passthrough()` — it accepts base64 IDs, numeric `int64`, empty `AnyValue: {}`, or `{stringValue:"x", boolValue:false}` without complaint.

This file layers the **refinement boundary** the proposal mandates (`proposal:99` — generated as structural truth + Zod refinements at `JaegerClient`):

| Refinement | Location | Rule | Why |
| --- | --- | --- | --- |
| Hex IDs | `schemas.ts:34` `traceIdHex` `/^[0-9a-f]{32}$/i`, `spanIdHex` `/^[0-9a-f]{16}$/i` | Rejects `format: bytes` base64 (`AQIDBA==`) confusion from OpenAPI spec | `proposal:82`, `RFC 0002 §3.6` |
| Decimal nanoseconds | `schemas.ts:41` `decimalNanoString: /^\d+$/` | `startTimeUnixNano`/`endTimeUnixNano`/`timeUnixNano`/`intValue` must be quoted decimal strings — `BigInt` not `Number` | `proposal:83` |
| Numeric enums | `schemas.ts:48` `spanKindEnum 0-5`, `statusCodeEnum 0-2` optional | Omitted `kind` = `UNSPECIFIED`, `status:{}` → `UNSET` (probe trace); out-of-range `99` rejected | `proposal:84` |
| AnyValue one-of | `schemas.ts:76` `refinedAnyValue: z.lazy` + `superRefine` exactly-one-of 7 keys via `!== undefined` | Preserves falsy `""`/`false`/`"0"`/`9223372036854775807`; `arrayValue`/`kvlistValue` recursive via `refinedArrayValue:104`/`refinedKeyValueList:112` | `proposal:86` |
| OTLP hierarchy | `schemas.ts:116` `refinedResource`/`refinedScope:123`/`refinedSpanEvent:132`/`refinedSpanLink:141`/`refinedStatus:152`/`refinedSpan:156`/`refinedScopeSpans:177`/`refinedResourceSpans:185`/`refinedTracesData:189` | All `.passthrough()` but with above constraints on IDs/timestamps/enum/AnyValue | — |
| Envelope | `schemas.ts:192` `GetTraceResponseSchema = {result: TracesData}` | Validates grpc-gateway wrapper separately so future true streaming can be added without touching enrichment | `RFC 0002:498`, `proposal:81` |

Types exported: `GetTraceResponse`, `TracesDataWire`.

### 2.3 `packages/jaeger-ui/src/api/v3/client.ts:13`

- `client.ts:140` `fetchTrace(traceId: string): Promise<TracesDataWire>` — validates request ID with `traceIdHex`, `GET /api/v3/traces/{id}` via `fetchWithTimeout`, `response.ok` check, `GetTraceResponseSchema.parse(json)`, returns `validated.result`.
- `client.ts:155` `getTrace` alias matching `RFC 0002` naming.
- **Does NOT** rewire `hooks/useTraceLoading.ts:33` (still `JaegerAPI.fetchTrace → transformTraceData(...).asOtelTrace()`), so rollback is `revert schema-only PR` as required by `proposal:139`.

### 2.4 `knip.config.ts:52`

Adds `src/api/v3/schemas.ts` as `entry` so refinements not flagged as unused before `parser.ts` consumes them (mirrors `generated-client.ts` entry).

### 2.5 What we did NOT do

No `src/api/v3/parser.ts`, no `useTrace`/`useTraces` migration, no `OtelFacade`/`transformTraceData` deletion, no backend v1 deprecation, no file-upload parser. Next gated deliverable is iterative parser + hook wiring (weeks 3–4, `proposal:142`).

---

## 3. Wire-contract findings from the evidence fixture

Capture: `jaegertracing/jaeger:2.13.0` with `rich-otlp-probe.json:1` (nested attributes, `false`, events, links, missing kind, numeric kind). Queried `GET /api/v3/traces/0123456789abcdef0123456789abcdef` (`metadata.md:9`, `capture-v3-trace.sh:30`, `validate-v3-capture.sh:18`).

| Wire fact (`proposal:79` table + `RFC 0002 §3.6` encodings) | Parser/validation rule |
| --- | --- |
| `{"result": {"resourceSpans": [...]}}` envelope | Validate envelope separately (`GetTraceResponseSchema`) |
| IDs are 32-hex trace / 16-hex span lower-case | `traceIdHex`/`spanIdHex` regex; do not treat `format: bytes` as base64 |
| `startTimeUnixNano`/`endTimeUnixNano`/`intValue` are quoted decimal strings | `decimalNanoString` + `BigInt` diff before `/1000n` → `µs` |
| `kind`/`status.code` numeric when present, omitted when `0` | `optional()` enum 0–5 / 0–2; absent → UI default |
| `status: {}` for unset | Map to `UNSET` |
| `AnyValue` preserves `""`, `false`, arrays, nested `kvlist`, max int64 `9223372036854775807` | Recursive one-of with `!== undefined` |
| Backend order ≠ display order | Define UI ordering deliberately |

Fixture validated by `scripts/validate-v3-capture.sh` (`.result.resourceSpans | length>0`, hex regex, decimal string) and by Zod in `schemas.trace-contract.test.ts:18`.

---

## 4. Existing open PRs covering the same ground

All are `OPEN` against `jaegertracing/jaeger-ui` as of 2026-09-03 (`gh api pulls --paginate`):

| PR | Title | Author | State | Relation to first step |
| --- | --- | --- | --- | --- |
| **#4129** | `feat(api/v3): Load traces via OTLP parser` | `Me-Priyank` | `OPEN` updated 2026-08-28 | **Direct overlap.** Implements `JaegerClient.getTrace`, `src/api/v3/parser.ts` (iterative DFS, depth/relative timing/inbound links), wires `useTrace`/`useTraces`. Handles streaming envelope (single object, JSON array, or concatenated `{"result":..}` objects with brace tracking in strings) — ours only handles single object. Parity tests vs legacy transform on 40-span trace. `RFC 0002 Milestone 3.2` prereq for deleting facade. |
| **#3890** | `feat(api/v3): Expose Zod schemas for OTLP trace/span types` | `gkhulbe4` | `OPEN` updated 2026-08-28 | Re-exports `generated-client.ts` OTLP schemas via `schemas.ts`, fixes `postprocess-schemas.cjs` stripping `.partial()` on union types. **No refinements** — no hex, no BigInt, no enum range, no AnyValue one-of. Our `schemas.ts:41` is the competing refinement the proposal says to judge. |
| **#3977** | `feat(api/v3): extend OTLP Zod schema coverage` | `SRIJAN-KUMAR7` | `CLOSED` 2026-08-24 `merged:false` | Competing refinement, closed without merge. Proposal `p.158` says compare `3890` vs `3977` vs live capture and take useful refinements. |
| **#4048** | `feat(monitor): Migrate metrics fetching from Redux to React Query` | `parshipcy` | `OPEN` | Redux removal track (`RFC 0004 Phase 2f`), not trace wire but part of final `Redux fully removed`. |
| **#4376** | `Remove dead hoverIndentGuideIds Redux state` | `Jeevanm2004` | `OPEN` | Small timeline Redux cleanup. |
| **#4199** | `fix(FileLoader): stop reporting OTLP backend-transform failures as parse errors` | `bhuvan-somisetty` | `OPEN` | Documents `/api/transform` upload dependency our step will delete by parsing OTLP files in-browser. |
| **#4112** | `refactor: Migrate store.layout.ts to Zustand persist middleware` | — | `OPEN` | Layout precedence (`RFC 0007`) — unrelated to wire contract. |
| **#3852** / **#3853** | URL utilities / non-persistence semantics | `Suyog241005` | `CLOSED` | Layout URL work, referenced in proposal as alignment items. |

`proposal:151–162` explicitly says: _Do not ignore active contributions. Rebase, preserve alias caching/domain fields, replace parser-local wire types with network-boundary validation, credit author, add regression tests. A merged PR the mentee helped land counts as deliverable met._

### Overlap analysis

- **Schemas:** `3890` (re-export) vs our `schemas.ts` (re-export + refinements) vs `3977` (closed alt refinements). Proposal choice is `3890` approach _plus_ refinements for known discrepancies (hex vs base64, decimal strings, enums, AnyValue) — exactly what our file does. Decision needed before either is reviewed in depth (`RFC 0002 §3.7`).
- **Client:** `4129` `getTrace` handles streaming; ours `client.ts:140` handles single-object only. Must adopt `4129`'s brace-tracking merge if envelope streaming (`jaeger#6467`) is kept separable.
- **Parser:** `4129` already builds enriched `IOtelTrace` (depth, parent/child, relative timing, critical path) iteratively. Our step deliberately stopped before parser to keep PR reversible — next PR should rebase `4129` rather than rewrite.

### 4.1 Deep dive — PR #3890 similarity to week-1 goal and required fix

**PR #3890 (`feat(api/v3): Expose Zod schemas for OTLP trace/span types`, `gkhulbe4`, `OPEN`, 234 commits behind `main` as of 2026-09-03):**

- **Goal — identical to our week-1 goal:** complete Zod coverage for full trace/span wire types so consumers like the `getTrace` hook (`#4129`/`#3835`, `RFC 0002 Milestone 3.2`) have a clean import. Both treat `generated-client.ts:205` (`TracesData`, `ResourceSpans`, `ScopeSpans`, `Span`, `Span_Event`, `Span_Link`, `Resource`, `InstrumentationScope`, `KeyValue`, `AnyValue`, `ArrayValue`, `KeyValueList`, `Status`) as structural truth via `openapi-zod-client`.

- **Approach as branched (234 commits ago):**
  1. Regenerate `generated-client.ts` from `jaeger-idl/swagger/api_v3/query_service.openapi.yaml`.
  2. `scripts/postprocess-schemas.cjs:38` strips the blanket `.partial()` the codegen applies (Proto3/OpenAPI optionality mismatch — every field `.partial().passthrough()` is too permissive), then restores `.partial()` only on the three attribute-value union types `UNION_TYPES=['AnyValue','ArrayValue','KeyValueList']` which are proto3 `oneof` — a real message only ever sets one variant field.
  3. Injects convenience aliases into the generated file so consumers write `import { AnyValueSchema } from './schemas'` instead of `schemas.X` — `postprocess:58` block `export { AnyValue as AnyValueSchema }` / `TracesData as TracesDataSchema` etc (16 exports).

- **What it actually changed (still on `pr-3890-otel-schemas` branch):** `schemas.ts:12` now re-exports those 16 via `export { TracesData as TracesDataSchema }` etc sourced from the generated file, `postprocess` adds the Zodios comment-out + header logic, `generated-client.ts:41` still has bare `AnyValue`/`ArrayValue` names (not yet regenerated, so PR still passes `tsc` on its old base).

- **Why the last mechanism is now broken:** `main` regenerated since this branched. Current codegen emits package-qualified names (`main:generated-client.ts:91` `opentelemetry_proto_common_v1_AnyValue: z.ZodType<opentelemetry_proto_common_v1_AnyValue>`, `opentelemetry_proto_trace_v1_Span`, `jaeger_api_v3_GetServicesResponse`, …). The restore regex `const ${name}: z.ZodType<${name}>` with `name='AnyValue'` no longer matches `const opentelemetry_proto_common_v1_AnyValue`, so it silently `console.warn` and leaves the union types fully-required (breaks `AnyValue:{stringValue:"hello"}` and nested `arrayValue:{values:[{stringValue:"a"}]}`). The convenience block literally `export { AnyValue as AnyValueSchema }` references an identifier that no longer exists → hard `tsc` error `error TS2304: Cannot find name 'AnyValue'.` ×16 the moment you `pnpm run generate:api-types` against current spec.

  Separately: `main` already solved half independently while `3890` sat open. `main:packages/jaeger-ui/src/api/v3/schemas.ts:18` exports `ServicesResponseSchema`/`OperationsResponseSchema`/`OperationSchema`/`TraceSummariesResponseSchema` by `const { jaeger_api_v3_GetServicesResponse } = schemas` off the `schemas` bundle object (`generated-client.ts:216` `export const schemas = { ... }`), not by injecting bare-name exports into the generated file. That `schemas.<qualified-name>` destructuring is the one thing that survives the rename (update one line on next codegen change vs silent breakage).

- **How similar to our week-1 changes:** Both expose the full OTLP surface to the boundary. `3890` stops at re-export + `.partial()` fix for unions. Ours (`schemas.ts:36`) builds on that and adds the refinement layer the proposal gates: hex ID regex (`traceIdHex`/`spanIdHex`), `decimalNanoString`/`BigInt` for 64-bit, `spanKindEnum`/`statusCodeEnum`, `refinedAnyValue` exactly-one-of via `superRefine` with `!== undefined` to keep `""`/`false`/`"0"`, and `GetTraceResponseSchema={result:TracesData}` envelope separation. Both are schema-only and intentionally do not touch `hooks/useTraceLoading.ts:33` — i.e. both satisfy `proposal:139` rollback = revert schema-only PR.

- **Changes needed in `3890` to synchronize (validated fix, not assertion):** Drop the convenience-export injection from `postprocess-schemas.cjs` entirely; add the 13 non-recursive trace/span exports (`TracesDataSchema`, `ResourceSpansSchema`, `ScopeSpansSchema`, `SpanSchema`, `SpanEventSchema`, `SpanLinkSchema`, `ResourceSchema`, `InstrumentationScopeSchema`, `StatusSchema`, `KeyValueSchema` plus the 4 already on `main`) to `schemas.ts` the same way `main` does the other four (`export const FooSchema = schemas.opentelemetry_proto_...`). Keep `.partial()` restoration **in `postprocess`** specifically for the mutually recursive triple (`AnyValue`/`ArrayValue`/`KeyValueList` + `KeyValue` — `AnyValue.arrayValue: ArrayValue`, `ArrayValue.values: AnyValue[]`, `KeyValue.value: AnyValue`) because re-deriving with `.unwrap().partial()` in `schemas.ts` leaves nested fields pointing at the original required version (verified: isolated `AnyValue` looks fixed but `{arrayValue:{values:[{stringValue:"value"}]}}` still fails). Fix the restore regex to match by suffix `(\w*AnyValue)` / `(\w*ArrayValue)` etc instead of exact `AnyValue` so `opentelemetry_proto_common_v1_AnyValue` matches and next rename does not silently regress.

  Proof after that edit: fresh `pnpm run generate:api-types`, `AnyValueSchema.safeParse({stringValue:'hello'}).success` and recursive `{arrayValue:{values:[{stringValue:'a'}]}}` both pass, `tsc --noEmit` clean, `pnpm --filter jaeger-ui test src/api/v3 --run` 106/106 green on this machine. Full `pnpm test` still shows 15 `localStorage.clear is not a function` fails (`GenAITab`/`message-format-store`) — checked on clean `upstream/main` checkout with none of my changes, same failure, so environment noise not this PR. Either push the resolved `pr-3890-otel-schemas` branch or use this recipe to avoid a duplicate schema PR; then rebase `lfx-week1-validated-wire-contract` refinements on top and let `4129` parser rebase on the validated boundary.

---

## 5. Coverage gap — what we are trying to cover that is still open

| Deliverable (`proposal:139`) | Status after our local changes | Gated by |
| --- | --- | --- |
| Validated v3 wire contract | **Done locally** — generated + refinements + fixtures + malformed tests + live `validate-v3-capture.sh` | Needs PR + review; reconcile with `4129`/`3890` |
| Native trace fetch (`validated getTrace + iterative parser + Query hook`) | **Partial** — `fetchTrace` validated, no parser, no hook wiring | Rebase `4129` parser, replace `useTraceLoading.ts:33` |
| Visual/perf parity (50k–80k spans) | Not started | Requires parser + same-trace comparison |
| Native OTLP upload (in-browser parser) | Not started | Requires parser |
| Legacy cleanup (facades/transformer/types) | Not started | Requires parity sign-off |
| Backend v1 deprecation | Not started | Requires UI no longer calls `/api/traces` etc |
| Redux removal / analytics migration | Not started (`4048`/`4376` open) | Separate track |
| Layout priority resolver | Not started | Separate track |

---

## 6. Validation performed

- `bash lfx-term-3-evidence/scripts/validate-v3-capture.sh lfx-term-3-evidence/fixtures/v3-trace-local-2.13.0.json` → `Capture has a v3 envelope...` pass.
- `pnpm --filter @jaegertracing/jaeger-ui test src/api/v3/schemas.trace-contract.test.ts src/api/v3/client.trace-contract.test.ts src/api/v3/schemas.test.ts src/api/v3/client.test.ts --run` → 97 passed; `schemas.trace-contract` 18/18, `client.trace-contract` 7/7.
- `pnpm run fmt` / `pnpm run tsc-lint` / `pnpm exec knip` / `pnpm run build` → pass (`lint` 0, `build` `✓ built in 955ms`). Full `pnpm test` shows 15 files / 340 tests failing on `main` as well (`localStorage.clear` `TypeError` in `GenAITab/message-format-store.test.ts`) — baseline, not introduced by this change (verified via `git stash --keep-index`).

---

## 7. Recommended next actions (per proposal collaboration plan)

**Sequencing confirmed: help `3890` → push yours rebased on `3890` → help `4129` consume it.** This keeps one validated source per `ADR-0002:40` and makes `3890` + `4129` connect as `#4278` requires (schema half + parser half = one validated path), per `proposal:151` helping counts as deliverable.

1. **Help `3890` land first** — `3890` is the base `generated → schemas.ts` re-export that all later steps import. Post `pr-3890-comment.txt:1` on `https://github.com/jaegertracing/jaeger-ui/pull/3890` (drop convenience-export injection, export 13 trace/span schemas via `schemas.<qualified-name>` like `main:packages/jaeger-ui/src/api/v3/schemas.ts:18`, keep `.partial()` restore for recursive `AnyValue/ArrayValue/KeyValueList/KeyValue` in `postprocess` with suffix `\w*AnyValue`). Let author push or `gh pr checkout 3890 && git push` if `allow edits` is on. This unblocks regeneration (`opentelemetry_proto_common_v1_AnyValue` vs bare `AnyValue` → `TS2304` ×16) and restores union `.partial()`.

2. **Then push yours `lfx-week1-validated-wire-contract:8df6768c` rebased on landed `3890`** — your `schemas.ts:34` `traceIdHex`/`schemas.ts:41` `decimalNanoString`/`schemas.ts:48` `spanKindEnum`/`schemas.ts:76` `refinedAnyValue` one-of/`schemas.ts:192` `GetTraceResponseSchema` is the refinement layer `proposal:99` that `3890` alone lacks.

   ```bash
   git checkout lfx-week1-validated-wire-contract
   git fetch origin && git rebase origin/main   # picks up merged 3890's 13 exports
   git push -u origin lfx-week1-validated-wire-contract
   ```

3. **Then help `4129` consume it** — `4129` (`src/api/v3/parser.ts:12` private `IOtlp*` + `client.ts:getTrace` streaming with brace tracking + `hooks/useTraceLoading.ts:33` wiring) should replace private wire interfaces with `import { TracesDataWire, GetTraceResponseSchema } from './schemas'` validated at `JaegerClient` boundary (`client.ts:140`), not in parser. Rebase `4129` on step 2, preserve iterative parser + parity tests.

### 7.1 What to look at in weeks 1–2 (scope)

**Weeks 1–2 = `proposal:201` _Validated v3 wire contract_ only. The only PRs you need to review are `3890` (and its closed alt `3977` for comparison) — not `4129`'s parser, not `4048`/`4376`/`4112`:**

| PR | Needed in weeks 1–2? | Why |
| --- | --- | --- |
| **#3890** | **Yes — primary** | Schema half: exposes OTLP `TracesData`/`Span`/`AnyValue` etc to the boundary. Your refinements (`hex/BigInt/enum/AnyValue`) layer directly on top of it. `RFC 0002 §3.7` says decide `3890` vs `3977` before deep review. |
| **#3977** | **Yes — read-only** | Competing refinement, already `CLOSED` 2026-08-24. Compare vs `3890` vs live `v3-trace-local-2.13.0.json:1` per `proposal:158`, take useful bits, do not re-open. |
| **#4129** | **Context only** | Its `client.ts:getTrace` streaming envelope handling (concatenated `{"result":..}`) is worth reading for `schemas.ts:192` envelope separation, but its `parser.ts:12` private `IOtlp*` and hook wiring are **weeks 3–4** (`proposal:142` Native trace fetch). Don't review the parser in depth yet — it will be rebased onto your validated boundary after step 2. |
| #4048 / #4376 / #4199 / #4112 | No | Redux/metrics, layout persist (`store.layout.ts`), upload error handling — separate migrations (`RFC 0004` / `RFC 0007`), weeks 6–11 per `proposal:201`. Note existence per `proposal:152` persistence seam, but no action now. |

In short: **look at `3890` (+ closed `3977` as reference) in weeks 1–2; skim `4129`'s envelope code for awareness; defer `4129` parser and all `4xxx` non-trace PRs.** Post-`3890` landing, your `refined*` PR becomes the weeks 1–2 deliverable, then `4129` becomes the weeks 3–4 deliverable on top of it.

---

## 8. Current sync — 2026-09-05

**Where we are now (both branches backed up on `origin`):**

- `lfx-week1-validated-wire-contract:b27955e2` (pushed `origin/lfx-week1-validated-wire-contract`) — validated wire contract with refinements (`schemas.ts:34` hex, `decimalNanoString`, `spanKindEnum`, `refinedAnyValue` one-of, `GetTraceResponseSchema` envelope via `lfx-term-3-evidence/fixtures/v3-trace-local-2.13.0.json:1` + `scripts/validate-v3-capture.sh:18`). `src/api/v3` 97/97 green on this branch (`schemas.trace-contract` 18 + `client.trace-contract` 7 + `schemas.test`/`client.test`).

- `pr-3890-otel-schemas:81d1e3cd` (pushed `origin/pr-3890-otel-schemas`) — rebased `gkhulbe4:3890` onto `upstream/main:c681703d` (was 234 behind). Fixed the qualified drift `opentelemetry_proto_common_v1_AnyValue` (`main:generated-client.ts:105`) → `postprocess:52` suffix `\w*AnyValue` restore (3 unions, `KeyValue` stays strict as `schemas.test.ts:493` expects), `schemas.ts:78` 13 qualified `schemas.opentelemetry_proto_...` re-exports (no `<<<<<<<` markers), `generated-client.ts:91` qualified. `pnpm --filter jaeger-ui test src/api/v3 --run` **106/106** (`schemas.test` 74 + `client.test` 32) after `node scripts/postprocess-schemas.cjs` `Removed 13, restored 3`. The extra `8c0d38fb` “remove markers” commit was squashed — history is now `81d1e3cd` on top of `d3894929` (no stray fix commit) and all 4 original `gkhulbe4` commits remain `Signed-off-by`.

- `pr-3890-comment.txt:1` is the suggestion + confirmation message for `https://github.com/jaegertracing/jaeger-ui/pull/3890` (suffix regex + move 13 exports to `schemas.ts`).

**What was missing and is now fixed in `pr-3890`:** section `4.1` qualified-name breakage (`TS2304` ×16, silent `Could not restore .partial()`) — now resolved via suffix match and `schemas.ts` qualified destructuring, so `pnpm run generate:api-types` + `tsc --noEmit` are clean.

**Next:** post `pr-3890-comment.txt:1` on `3890`, let it land, then `git checkout lfx-week1-validated-wire-contract && git rebase origin/main` to pick up the landed 13 exports, then help `4129` (`src/api/v3/parser.ts:12` private `IOtlp*` → `import { TracesDataWire } from './schemas'`) per `§7` sequencing. `4112` (`store.layout.ts` `persist`) stays deferred to week 11 (`§7.1`).

_Pushed: `origin/lfx-week1-validated-wire-contract` and `origin/pr-3890-otel-schemas` on 2026-09-05. To land the refined contract: `git checkout lfx-week1-validated-wire-contract && pnpm run fmt && pnpm run lint && pnpm --filter jaeger-ui test src/api/v3 --run`._
