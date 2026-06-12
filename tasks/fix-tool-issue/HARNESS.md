# T7 verification harness — run instructions

The harness lives at [`scripts/tool-matrix-validator.mjs`](../../scripts/tool-matrix-validator.mjs).

It exercises every Anthropic typed tool (sourced from
`open-sse/config/anthropicToolRegistry.js`) against the running 9router gateway
on both `cc/` and `kr/` paths, plus a custom-tool regression baseline. For
each combination it streams the response, accumulates `input_json_delta.partial_json`
to reconstruct the tool input (the `content_block_start` `input` field is
intentionally ignored — that placeholder is what caused the original false
"empty input" finding), and writes a markdown matrix to
`tasks/fix-tool-issue/tool_matrix_after.md`.

## Run

```bash
PATH="/Users/buithanhbavuong/.nvm/versions/node/v22.22.3/bin:$PATH" \
GATEWAY_URL=http://buis-mac-mini.local:20128/v1 \
GATEWAY_API_KEY=<token> \
node scripts/tool-matrix-validator.mjs
```

## Flags

| Flag | Default | Notes |
|---|---|---|
| `--gateway <url>` | `$GATEWAY_URL` then `http://buis-mac-mini.local:20128/v1` | Base URL; `/messages` and `/models` are appended. |
| `--timeout-ms <n>` | `60000` | Per-request abort deadline. |
| `--output <path>` | `tasks/fix-tool-issue/tool_matrix_after.md` | Matrix destination. |
| `--cc-model <id>` | `cc/claude-opus-4-8` | Override cc/ model id. |
| `--kr-model <id>` | `kr/claude-opus-4.8` | Override kr/ model id. |

`GATEWAY_API_KEY`, if set, is sent as both `x-api-key` and `Authorization: Bearer`.
If unset and the gateway requires auth (probe `/models` returns 401), the harness
writes a stub matrix and exits 2 instead of running.

## Exit codes

- `0` — every (type × path) cell met its target state from §4 of `tasks.md`.
- `1` — at least one cell failed; see the **Failures** section in
  `tool_matrix_after.md` for HTTP status, body, reasons, and the
  reconstructed blocks.
- `2` — gateway unreachable, or auth required and no `GATEWAY_API_KEY` set;
  a stub matrix is emitted at `OUTPUT` documenting how to run it manually.

## What's verified per cell

| Path | Category | Required |
|---|---|---|
| `cc/` | A (server-executed) | HTTP 200 + `server_tool_use` block + non-empty reconstructed input + `*_tool_result` block + `stop_reason ∈ {tool_use, end_turn}` |
| `cc/` | B (client built-in) | HTTP 200 + `tool_use` block + non-empty input + `stop_reason = tool_use` |
| `kr/` | A (downgraded) | HTTP 200 + `tool_use` block + non-empty input + `stop_reason = tool_use` |
| `kr/` | B (downgraded) | HTTP 200 + `tool_use` block + non-empty input + `stop_reason = tool_use` |
| both | C (custom regression) | HTTP 200 + `tool_use` block + non-empty input + `stop_reason = tool_use` |

The custom-tool row is the regression baseline: both paths must continue to
work end-to-end with a plain `{name, description, input_schema}` tool
(`lookup_inventory`).
