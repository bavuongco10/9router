# Server Tools Fix Spec — Anthropic typed tools on the Kiro gateway

Gateway: `http://buis-mac-mini.local:20128/v1`  (Anthropic-compatible shim over Kiro/CodeWhisperer + a direct-Anthropic `cc/` path)

Audience: coding agents with access to the GATEWAY source. Tasks below contain assumptions about
gateway internals that the implementing agent MUST verify against the real code before editing.

---

## 1. Problem definition

Anthropic's Messages API supports two shapes of `tools[]` entries:

- **Custom tool** — `{ "name": ..., "description": ..., "input_schema": {...} }`  (works today).
- **Typed/built-in tool** — `{ "type": "<name>_<version>", "name": ... }` with NO `input_schema`,
  because the schema (and sometimes the execution) is predefined by Anthropic.

The gateway only handles the custom shape. Every typed tool is mishandled. Observed on this gateway:

| Path | Behavior with a typed tool (e.g. `web_search_20250305`) |
|---|---|
| `cc/...` (direct Anthropic) | **400 invalid_request_error** — `tools.0.web_search_20250305...` rejected |
| `kr/...` (CodeWhisperer) | Forwarded as a SCHEMALESS custom tool → model emits a tool_use with no usable args, and NO backend ever executes it. Originally misread as "empty input"; with correct `input_json_delta` reconstruction the model DOES emit args once a schema is present. |

Confirmed counter-fact: a **custom** `web_search` tool WITH `input_schema {query:string}` works on `kr/`
end-to-end (model emits a real query → client runs search → `tool_result` fed back → cited answer).
So the model is fine; the GATEWAY's typed-tool handling is the defect.

### Tool types in scope (from Anthropic tool registry)

Categorize each — handling differs by category:

**A. Server-executed** (Anthropic runs it, returns `server_tool_use` + `*_tool_result` inline):
- `web_search_20250305`, `web_search_20260209`
- `web_fetch_20250910`, `web_fetch_20260209`, `web_fetch_20260309`
- `code_execution_20250522`, `code_execution_20250825`, `code_execution_20260120`

**B. Client-executed built-ins** (Anthropic-defined schema, CLIENT executes, returns `tool_result`):
- `bash_20250124`
- `text_editor_20250124`, `text_editor_20250429`, `text_editor_20250728`
- `memory_20250818`
- `tool_search_tool_bm25`, `tool_search_tool_bm25_20251119`,
  `tool_search_tool_regex`, `tool_search_tool_regex_20251119`

**C. Custom** — `custom` / plain name+input_schema. Already works; use as the regression baseline.

### Root causes (hypotheses to confirm in code)
1. Tool-normalization layer assumes `input_schema` is always present → typed tools become schemaless.
2. No registry mapping versioned `type` → canonical input_schema + category + native mapping.
3. `cc/` path passes the typed tool to upstream Anthropic but the upstream account/version doesn't
   accept that exact `type` string (or the gateway forwards an unsupported `anthropic-version`).
4. `kr/` path has no concept of server-executed tools, and no mapping to Kiro's NATIVE
   `web_search`/`web_fetch` built-ins (which exist in Kiro CLI 1.21.0+ but are not in the
   CodeWhisperer `GenerateAssistantResponse` API the gateway translates).

---

## 2. Fix plan (strategy)

Build a **tool-type registry** as the single source of truth, then branch handling by category and
provider path:

- **Registry**: `type-string → { family, version, category(A/B/C), input_schema, kiro_native?, min_anthropic_version }`.
- **cc/ path (server-executed A + built-in B)**: pass typed tools through UNCHANGED to Anthropic, with
  the correct `anthropic-version` / beta headers each type requires. Surface upstream 4xx verbatim
  instead of swallowing.
- **kr/ path (category A)**: map `web_search*`/`web_fetch*` to Kiro's native web tools if reachable;
  otherwise DOWNGRADE to a custom tool (inject the registry `input_schema`) so a client-side loop
  works. `code_execution*` → if no Kiro equivalent, downgrade to custom or reject with a clear 422.
- **kr/ path (category B)**: inject the registry `input_schema` so the model emits valid `tool_use`;
  these are client-executed anyway, so a correct schema is sufficient.
- **Round-trip**: ensure `tool_result` blocks (and `server_tool_use`/`*_tool_result` if produced)
  are accepted on the way back and translated correctly in multi-turn history.
- **Fail loud**: any unsupported `type` returns a structured 422 naming the type — never silently no-op.

---

## 3. Tasks (feed to agents)

> Each task: **Goal / Context / Steps / Acceptance**. `Files` are GUESSES — confirm against real code.
> Dependencies noted. Recommend doing T0 → T1 first; T2/T3/T4 can parallelize after T1.

### T0 — Reproduce & catalog current behavior  (no code change)
- **Goal**: Ground-truth table of what the gateway does today for every in-scope type, on both paths.
- **Steps**: For each `type` in §1, send a minimal request with that tool on `cc/claude-opus-4-8`
  and `kr/claude-opus-4.8`. Record: HTTP status, error body, whether a `tool_use`/`server_tool_use`
  block appears, and the RECONSTRUCTED input (accumulate `input_json_delta`, do NOT read the
  `content_block_start` placeholder). Save as `tool_matrix_before.md`.
- **Acceptance**: A filled matrix (type × path → status/block/input) committed; no guesses left blank.

### T1 — Tool-type registry  (blocks T2,T3,T4,T5)
- **Goal**: One module mapping each versioned `type` → metadata + canonical `input_schema`.
- **Context**: Pull canonical schemas from Anthropic docs for text_editor/bash/memory/tool_search;
  mark web_search/web_fetch/code_execution as server-executed (no client schema needed on cc/, but
  provide a downgrade schema for kr/, e.g. web_search → `{query:string}`, web_fetch → `{url:string}`).
- **Files (guess)**: `tools/registry.*`, wherever tool normalization currently lives.
- **Acceptance**: `resolveToolType("web_search_20250305")` etc. returns correct category + schema for
  ALL §1 types; unknown types return a typed "unsupported" sentinel (not null/crash). Unit-tested.

### T2 — cc/ path passthrough for typed tools  (dep: T1)
- **Goal**: Stop the 400. Forward typed tools unchanged to upstream Anthropic.
- **Steps**: Don't strip/rewrite entries that have a `type`. Attach the correct `anthropic-version`
  and any required beta header per type (from T1 metadata). If upstream still 4xx, propagate the
  upstream error body verbatim (don't mask as a generic gateway error).
- **Acceptance**: `cc/claude-opus-4-8` + `web_search_20250305` returns a real `server_tool_use` +
  `web_search_tool_result` and a cited answer in ONE request (no client loop). text_editor/bash/memory
  typed tools are accepted (model emits valid `tool_use`).

### T3 — kr/ path: inject schemas for client-executed built-ins (category B)  (dep: T1)
- **Goal**: Make `bash_*`, `text_editor_*`, `memory_*`, `tool_search_*` usable on kr/.
- **Steps**: On kr/, replace each typed category-B tool with a custom tool carrying the registry
  `input_schema` and the canonical tool name. Leave execution to the client (these are client tools).
- **Acceptance**: For each category-B type, model emits a `tool_use` with schema-valid input
  (reconstructed from deltas), `stop_reason=tool_use`; feeding a `tool_result` back yields a coherent
  continuation. No 400, no empty-input calls.

### T4 — kr/ path: server-executed tools (category A)  (dep: T1)
- **Goal**: Make `web_search*` / `web_fetch*` (and decide `code_execution*`) work on kr/.
- **Steps**:
  - If the gateway can reach Kiro's native `web_search`/`web_fetch`, map category-A tools onto them
    and surface their results as `tool_result`/`web_search_tool_result`.
  - Else DOWNGRADE to a custom tool (inject T1 schema) so the documented client-side loop works.
  - `code_execution*`: if no Kiro/host sandbox, return a clear 422 naming the type (do not silently
    accept-and-noop).
- **Acceptance**: `kr/claude-opus-4.8` + a web_search tool either (a) returns results inline via Kiro
  native, or (b) cleanly supports the client loop (query out → tool_result in → cited answer).
  Decision for code_execution documented and enforced.

### T5 — tool_result / multi-turn round-trip  (dep: T2,T3,T4)
- **Goal**: Accept tool outputs on the way back and preserve them in history translation.
- **Steps**: Ensure `tool_result` blocks, and any `server_tool_use`/`*_tool_result` the gateway
  emits, are parsed inbound and correctly mapped into Kiro `userInputMessageContext.toolResults`
  (kr/) or passed through (cc/). Preserve tool_use IDs across turns.
- **Acceptance**: A 2-turn conversation (tool_use → tool_result → final answer) succeeds on BOTH
  paths for at least web_search and text_editor; tool_use_id matches across turns.

### T6 — Fail-loud errors & observability  (dep: T1)
- **Goal**: No silent no-ops; debuggable.
- **Steps**: Unsupported/unmapped types → structured 422 `{type, reason:"UNSUPPORTED_TOOL_TYPE"}`.
  Log, per request, each tool type seen and the handling branch taken (passthrough / inject / map /
  reject). Add a debug dump of the outbound backend body.
- **Acceptance**: Sending a bogus `type` returns 422 naming it; logs show the branch per tool.

### T7 — Verification harness & regression matrix  (dep: T2–T6)
- **Goal**: Automated proof, reusable on every change.
- **Steps**: Script that runs the §4 matrix across all §1 types × both paths, reconstructing tool
  input from `input_json_delta`, and runs the full round-trip for web_search + text_editor. Emit
  `tool_matrix_after.md` and diff against T0's `tool_matrix_before.md`.
- **Acceptance**: All category-A/B types reach their target state (§4); category-C still green;
  matrix committed and green in CI.

### T8 — Docs
- **Goal**: Document which typed tools are supported on which path, and the client-loop contract.
- **Acceptance**: README/section listing every §1 type → cc/ behavior, kr/ behavior, and example
  request/response for web_search (server-side on cc/, client-loop on kr/).

---

## 4. Verification — target-state matrix (acceptance for the whole effort)

Reconstruct tool input by ACCUMULATING `input_json_delta.partial_json` — never read the
`content_block_start` placeholder (that bug caused the original false "empty input" finding).

| Tool family | Category | cc/ target | kr/ target |
|---|---|---|---|
| web_search_* | A | inline `server_tool_use`+result, cited answer, 1 request | Kiro-native results OR client-loop with `{query}` schema |
| web_fetch_* | A | inline server result | Kiro-native OR client-loop with `{url}` schema |
| code_execution_* | A | inline server result | mapped if sandbox exists, else 422 (named) |
| bash_20250124 | B | accepted, valid `tool_use` | schema injected, valid `tool_use`, client executes |
| text_editor_* | B | accepted, valid `tool_use` | schema injected, valid `tool_use`, client executes |
| memory_20250818 | B | accepted, valid `tool_use` | schema injected, valid `tool_use`, client executes |
| tool_search_tool_* | B | accepted, valid `tool_use` | schema injected, valid `tool_use` |
| custom / name+schema | C | works (regression baseline) | works (regression baseline) |

Global pass conditions:
- No `400`/silent-noop for any in-scope type (server-executed may legitimately 422 on kr/ ONLY if no
  backend exists, and must NAME the type).
- Every emitted `tool_use` has schema-valid, non-empty reconstructed input.
- Round-trip (tool_result fed back) yields a coherent, cited (for search) final answer on both paths.
- `tool_matrix_after.md` shows all cells at target; category-C unchanged.

---

## 5. Known facts / constraints (do not re-derive)
- The model is NOT the problem — `kr/claude-opus-4.8` emits valid queries once a schema is present.
- Anthropic SERVER tools (`web_search_20250305`, etc.) carry no `input_schema` by design.
- Kiro has NATIVE `web_search`/`web_fetch` (CLI 1.21.0, 2025-11-25) but they are client built-ins,
  not in the CodeWhisperer `GenerateAssistantResponse` wire API the kr/ path translates.
- The `cc/` path reaches Anthropic directly (honors real adaptive thinking + effort); the `kr/` path
  is a legacy CodeWhisperer translation that predates server tools AND the effort feature.
- Reuse the working client-loop reference already validated on this gateway as the kr/ fallback.
