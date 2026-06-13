# Task 12 — Silent-drop diagnostics for unsupported Claude fields

**Priority:** P2 (observability — turns silent failures into visible ones)
**Files:** `9router-development/open-sse/translator/request/claude-to-kiro.js`, `9router-development/open-sse/translator/response/kiro-to-claude.js`, `9router-development/open-sse/translator/index.js`

## Problem

Several real Anthropic Messages API fields have no Kiro equivalent. The direct translator drops them silently. Real Claude clients use these (Claude Code's `QueryEngine.ts` in https://github.com/Tinkeringg-Lab/claude-code shows heavy use of `cache_control`, `thinking`-config, and tool definitions). When a route through direct produces different behavior than direct-Anthropic, the operator has no log trail to diagnose why.

| Field | What it does | What we should do |
|---|---|---|
| `cache_control` (top-level, on system blocks, on tools, on message blocks) | Prompt caching breakpoints | Drop + log; no Kiro caching API |
| `tool_choice` | Force / forbid / restrict tool use | Drop + log; no Kiro equivalent (workaround in task 07) |
| `output_config.format` | Structured outputs (JSON schema) | Drop + log |
| `output_config.effort` | Reasoning depth (low/medium/high/xhigh/max) | Drop + log; could approximate as system prompt instruction in a follow-up task |
| `output_config.task_budget` | Token cap with model awareness | Drop + log |
| `metadata.user_id` | Per-user tracking / abuse prevention | Drop + log (Kiro has no equivalent header) |
| `top_k` | Sampling parameter | Drop + log |
| `service_tier` | Priority routing | Drop + log |

## Fix

### Step 1 — Add a logger to the request translator signature

`claudeToKiroRequest(model, body, stream, credentials)` currently takes no logger. Add an optional fifth arg:

```js
// claude-to-kiro.js
export function claudeToKiroRequest(model, body, stream, credentials, log) {
  logDroppedClaudeFields(body, log);
  // ... existing body
}
```

Call it from `index.js`'s direct-route dispatch (file at `open-sse/translator/index.js:75-110`):

```js
// translateRequest, in the direct-route branch
const directFn = requestRegistry.get(`${sourceFormat}:${targetFormat}`);
if (directFn) {
  result = directFn(model, result, stream, credentials, reqLogger);
}
```

`reqLogger` is already a parameter to `translateRequest` (line 75) — just thread it through.

### Step 2 — The helper

```js
function logDroppedClaudeFields(body, log) {
  if (!log?.debug) return;
  const dropped = [];

  if (body.cache_control) dropped.push("cache_control(top-level)");
  if (Array.isArray(body.system) && body.system.some((s) => s?.cache_control)) {
    dropped.push("cache_control(system blocks)");
  }
  if (Array.isArray(body.tools) && body.tools.some((t) => t?.cache_control)) {
    dropped.push("cache_control(tools)");
  }
  // Cache-control on individual message content blocks: skip enumeration, just flag presence.
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m.content) && m.content.some((c) => c?.cache_control)) {
        dropped.push("cache_control(message blocks)");
        break;
      }
    }
  }

  if (body.tool_choice) dropped.push(`tool_choice=${JSON.stringify(body.tool_choice)}`);

  if (body.output_config) {
    if (body.output_config.format) dropped.push("output_config.format");
    if (body.output_config.effort) dropped.push(`output_config.effort=${body.output_config.effort}`);
    if (body.output_config.task_budget) dropped.push("output_config.task_budget");
  }

  if (body.metadata?.user_id) dropped.push("metadata.user_id");
  if (body.top_k !== undefined) dropped.push("top_k");
  if (body.service_tier) dropped.push(`service_tier=${body.service_tier}`);

  if (dropped.length > 0) {
    log.debug("CLAUDE_TO_KIRO", `Dropped unsupported Claude fields: ${dropped.join(", ")}`);
  }
}
```

Default-off (only fires when `log.debug` is wired in — same pattern other 9router translators already use).

### Step 3 — Always-emit cache fields in response usage

Anthropic responses always include `cache_creation_input_tokens` and `cache_read_input_tokens` in usage. The new `kiro-to-claude.js:751-759` only sets `input_tokens` and `output_tokens`. Claude SDKs treat absence as 0 in practice, but populating them explicitly is cleaner and matches the upstream contract:

```js
// kiro-to-claude.js — at the finish_reason branch, when building finalUsage
const finalUsage = state.usage
  ? {
      input_tokens: state.usage.input_tokens,
      output_tokens: state.usage.output_tokens,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
  : { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
```

Same on `kiroToClaudeNonStreaming` (lines 798-810) — return zeros explicitly.

## Don't add

- Don't try to emulate caching with a side-cache. Kiro genuinely doesn't have it; emulation is a different project.
- Don't try to map `effort` to a system prompt instruction in this task. That's a separate decision (see task 13's tool-choice doc for the precedent — heuristic system-prompt nudges are not shipped without sign-off).

## Acceptance criteria

- `claudeToKiroRequest` accepts an optional fifth `log` arg.
- `index.js` `translateRequest` direct-route branch passes `reqLogger`.
- A test stubs a logger with `log.debug = vi.fn()`, sends a request with `cache_control`, `tool_choice`, `output_config.effort`, `metadata: {user_id: "u"}`, and verifies one `log.debug` call lists all four.
- A test verifies absence-case (no logger / `log.debug` not present) doesn't throw and doesn't add output.
- `kiro-to-claude.js` emits `usage` with all four token fields populated (even if cache fields are 0).
- `pnpm vitest run tests/translator/` green.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
```

For a manual sanity check: run a Claude Code request through the direct route with `process.env.DEBUG=1` (or whatever the project uses to enable `log.debug`) and confirm a "Dropped unsupported Claude fields" line appears in stderr / log output.

## Why this matters

The number-one customer report on translator routes is "it's slower / dumber than going direct to Anthropic." Most often the answer is one of: caching is off (and has to be on Kiro), thinking budget got dropped, tool_choice was ignored. With this task shipped, an operator running with debug on can answer "what got dropped?" in one log search instead of an evening with `tcpdump`.

## References

- Anthropic field reference: `shared/tool-use-concepts.md`, `shared/prompt-caching.md`, `shared/model-migration.md` in the claude-api skill (cache_control, tool_choice, output_config — `format`/`effort`/`task_budget`, metadata).
- Existing logger usage in 9router: grep for `log?.debug?.(` under `open-sse/` to see the convention.
- Translator dispatch where `reqLogger` is already in scope: `open-sse/translator/index.js:75, 99`.
