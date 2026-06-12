# Tool Matrix — After State (T7) — STUB

- Reason: Gateway reachable but auth required and GATEWAY_API_KEY not set.
- Gateway: `http://buis-mac-mini.local:20128/v1`

Run manually with:

```bash
GATEWAY_URL=http://buis-mac-mini.local:20128/v1 \
GATEWAY_API_KEY=<token> \
node scripts/tool-matrix-validator.mjs
```

Combinations that will be exercised (18 types × 2 paths + custom):

- `web_search_20250305` (cat A)
- `web_search_20260209` (cat A)
- `web_fetch_20250910` (cat A)
- `web_fetch_20260209` (cat A)
- `web_fetch_20260309` (cat A)
- `code_execution_20250522` (cat A)
- `code_execution_20250825` (cat A)
- `code_execution_20260120` (cat A)
- `bash_20250124` (cat B)
- `text_editor_20250124` (cat B)
- `text_editor_20250429` (cat B)
- `text_editor_20250728` (cat B)
- `memory_20250818` (cat B)
- `tool_search_tool_bm25` (cat B)
- `tool_search_tool_bm25_20251119` (cat B)
- `tool_search_tool_regex` (cat B)
- `tool_search_tool_regex_20251119` (cat B)
- `custom` (cat C)
