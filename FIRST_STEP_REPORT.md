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

1. **Reconcile PRs before opening new one:** `gh pr view 4129 --json body` vs `gh pr view 3890 --json body` vs local `schemas.ts:41`; adopt streaming envelope handling from `4129`, keep `3890`'s `.partial()` fix, keep our hex/BigInt/enum/AnyValue refinements; close duplication.
2. **Shepherd smallest composable unit:** land `GetTraceResponseSchema` + `fetchTrace` validation PR first (our file), credit `3890` author for re-export, `4129` author for streaming logic.
3. **Then rebase `4129` parser** onto validated boundary — replace parser-local wire interfaces with `schemas.ts` types, preserve alias caching/critical-path, wire `useTrace`/`useTraces`, add parity + 80k-span bench before deleting facade.

---

_Generated for review; not yet pushed. To land: `git add knip.config.ts packages/jaeger-ui/src/api/v3/{schemas.ts,client.ts,schemas.trace-contract.test.ts,client.trace-contract.test.ts} && pnpm run fmt && pnpm run lint && pnpm --filter @jaegertracing/jaeger-ui test src/api/v3/*`_
