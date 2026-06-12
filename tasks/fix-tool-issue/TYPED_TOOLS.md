# Typed Tools (Anthropic Built-in Tools) on the 9router Gateway

The Anthropic Messages API accepts two shapes of `tools[]` entries:

- **Custom** — `{ name, description, input_schema }`. Always supported (regression baseline).
- **Typed** — `{ type: "<family>_<YYYYMMDD>", name }`. Schema (and sometimes execution) is predefined by Anthropic. Now supported on both gateway paths.

This doc describes how each typed tool is handled on the `cc/` (direct Anthropic) and `kr/` (Kiro / CodeWhisperer) paths.

## Categories

| Category | Execution | Examples |
|---|---|---|
| **A** | Anthropic-side (`server_tool_use` + `*_tool_result` inline) | `web_search_*`, `web_fetch_*`, `code_execution_*` |
| **B** | Client-side (Anthropic-defined schema, client runs the tool) | `bash_*`, `text_editor_*`, `memory_*`, `tool_search_tool_*` |
| **C** | Custom — caller provides the schema | any `name + input_schema` entry |

The single source of truth for type → category + schema mapping is
`open-sse/config/anthropicToolRegistry.js`.

## Behavior matrix

| Tool family | cc/ path | kr/ path |
|---|---|---|
| `web_search_*` (A) | passthrough — Anthropic returns inline `server_tool_use` + `web_search_tool_result` in one response | downgraded to a custom tool with `{query: string}` schema; client runs the search and feeds back `tool_result` |
| `web_fetch_*` (A) | passthrough — inline server result | downgraded to `{url: string}` schema; client-loop |
| `code_execution_*` (A) | passthrough — inline server result | downgraded to `{code: string}` schema; client decides whether to execute |
| `bash_20250124` (B) | passthrough — model emits `tool_use`; client executes | schema injected from registry; model emits `tool_use`; client executes |
| `text_editor_*` (B) | passthrough — model emits `tool_use`; client executes | schema injected from registry; model emits `tool_use`; client executes |
| `memory_20250818` (B) | passthrough | schema injected; client executes |
| `tool_search_tool_*` (B) | passthrough | schema injected; client executes |
| custom (C) | unchanged | unchanged |

## Headers (cc/ path)

Each typed tool has a registry-attached `betas[]` array. The cc/ executor
collects required betas across all tools in a request and unions them into the
outbound `Anthropic-Beta` header alongside the static CLI flags. Without this,
upstream Anthropic returns 400 invalid_request_error on the `type` string.

## Cloaking (cc/ path)

Typed tools are NOT cloaked. The `cloakClaudeTools` step skips them — only
custom tools get the `_ide` suffix. Renaming a typed tool's `name` causes
Anthropic to reject the request, so typed tools pass through unchanged with
the canonical `name` Anthropic expects.

## Round-trip

- **kr/**: client sends `tool_result` blocks → translated to Kiro
  `userInputMessageContext.toolResults[]` (with `is_error: true` →
  `status: "error"`). Kiro `toolUseEvent.toolUseId` is preserved end-to-end so
  multi-turn conversations match `tool_use_id` across turns.
- **cc/**: passthrough — `tool_result`, `server_tool_use`, and
  `*_tool_result` blocks flow unchanged in both directions.

## Fail-loud errors

An unknown `type` string is rejected with HTTP **422** and an Anthropic-shape
error envelope:

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "code": "UNSUPPORTED_TOOL_TYPE",
    "message": "Unsupported Anthropic typed tool: <type>",
    "tool_type": "<type>"
  }
}
```

This applies on both paths. To add support for a new typed tool, add an entry
to `anthropicToolRegistry.js` — no other code changes are needed.

## Per-request observability

Every request that includes tools logs a single line at debug level showing
the breakdown:

```
TOOLS: cc/claude-opus-4-8 tools=3 (typedA=1 typedB=1 custom=1) types=[web_search_20250305,bash_20250124]
```

Set `ENABLE_REQUEST_LOGS=true` for the full outbound body dump (written to
`logs/<session>/4_req_target.json`).

## Example — web_search on cc/

Request:
```json
{
  "model": "cc/claude-opus-4-8",
  "max_tokens": 1024,
  "stream": true,
  "messages": [
    { "role": "user", "content": "What's the latest news on AI safety?" }
  ],
  "tools": [
    { "type": "web_search_20250305", "name": "web_search" }
  ]
}
```

Response (SSE, abridged):
```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_01","name":"web_search","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"latest AI safety news 2026\"}"}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_01","content":[...]}}

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}
... cited final answer ...
```

The model's tool input is reconstructed by **accumulating
`input_json_delta.partial_json`** across deltas — never read the
`content_block_start.input` placeholder (it is `{}`).

## Example — web_search on kr/

Request: same shape, but `model: "kr/claude-opus-4.8"`.

Behavior: kr/ has no Kiro-native server-tool wire equivalent today, so the
gateway downgrades the typed tool to a custom tool with the registry's
`{query: string}` schema. The model emits a regular `tool_use` block, the
client runs the search, then feeds a `tool_result` back. Two-turn pattern.

Response from first turn (abridged):
```
event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"web_search","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"latest AI safety news 2026\"}"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}
```

Client's second turn:
```json
{
  "model": "kr/claude-opus-4.8",
  "messages": [
    { "role": "user", "content": "What's the latest news on AI safety?" },
    { "role": "assistant", "content": [{"type":"tool_use","id":"toolu_01","name":"web_search","input":{"query":"latest AI safety news 2026"}}] },
    { "role": "user", "content": [{"type":"tool_result","tool_use_id":"toolu_01","content":"<search results JSON>"}] }
  ],
  "tools": [
    { "type": "web_search_20250305", "name": "web_search" }
  ]
}
```

The gateway maps the `tool_result` block onto Kiro's
`userInputMessageContext.toolResults[]` with the matching `toolUseId`.

## Adding a new typed tool

1. Add an entry to `REGISTRY` in `open-sse/config/anthropicToolRegistry.js`:
   ```js
   new_tool_20260601: {
     family: "new_tool",
     category: "A" | "B",
     inputSchema: { type: "object", properties: { ... }, required: [...] },
     betas: ["new-tool-2026-06-01"],
     kiroNative: false
   }
   ```
2. If `name` differs from the family, add a `FAMILY_DEFAULT_NAME` entry too.
3. Add the type string to the harness coverage test in
   `tests/unit/anthropic-tool-registry.test.js` ("registry coverage" block).
4. Run the verification harness — see `HARNESS.md`.

## Verification harness

`scripts/tool-matrix-validator.mjs` exercises every typed tool against a live
gateway on both paths and emits `tool_matrix_after.md`. See `HARNESS.md` for
run instructions.
