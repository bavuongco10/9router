# Task 01 — Restore tool-arg sanitization on the direct response path

**Priority:** P0 (blocks merge — real regression)
**Files:** `9router-development/open-sse/translator/response/kiro-to-claude.js`, `9router-development/open-sse/translator/response/openai-to-claude.js`, new helper file.

## Problem

The pivot path's `openai-to-claude.js` runs `sanitizeToolArgs(toolName, buffered)` on the buffered tool-call arguments before emitting the final `input_json_delta` (see `openai-to-claude.js:223-232`). This fixes a class of bad params from non-Anthropic models — for the `Read` tool specifically:

- string-numeric `limit`/`offset` (`"100"` → `100`)
- `limit` clamped to `[1, 2000]`
- invalid `pages` arg dropped unless `file_path` is `.pdf` and value matches `^\d+(?:-\d+)?$`

The new direct path `kiro-to-claude.js` (see `kiro-to-claude.js:740-748` in the PR diff) emits `partial_json: buffered` raw — no sanitization. Any Kiro-served Claude client whose model produces a malformed `Read` invocation will now see it pass through unfixed on the direct route, regressing behavior that the pivot fixed.

## Fix

Extract the sanitizer to a shared helper, then call it from both response translators.

### Step 1 — Create the helper

New file: `9router-development/open-sse/translator/helpers/toolArgSanitizer.js`

Move these from `openai-to-claude.js`:

- `CLAUDE_OAUTH_TOOL_PREFIX` constant
- `sanitizeToolArgs(toolName, argsJson)`
- `sanitizeReadArgs(args)`
- `isValidPdfPagesArg(filePath, pages)`

Export `sanitizeToolArgs` and `CLAUDE_OAUTH_TOOL_PREFIX` (the latter is used to strip prefix from the user-facing tool name in both translators — see task 06 for prefix-strip parity).

Keep behavior identical. Do not "improve" the sanitizer in this task; the goal is parity, not new logic.

### Step 2 — Refactor `openai-to-claude.js`

Replace the inline definitions with `import { sanitizeToolArgs, CLAUDE_OAUTH_TOOL_PREFIX } from "../helpers/toolArgSanitizer.js"`. Delete the now-duplicate functions in this file. No behavior change.

### Step 3 — Wire into `kiro-to-claude.js`

In the `finish_reason` branch (around `kiro-to-claude.js:734-761` in the diff), where it loops over `state.toolCalls`:

```js
import { sanitizeToolArgs } from "../helpers/toolArgSanitizer.js";
// ...
for (const [idx, toolInfo] of state.toolCalls) {
  const buffered = state.toolArgBuffers?.get(idx);
  if (buffered) {
    const sanitized = sanitizeToolArgs(toolInfo.name, buffered);
    results.push({
      type: "content_block_delta",
      index: toolInfo.blockIndex,
      delta: { type: "input_json_delta", partial_json: sanitized },
    });
  }
  results.push({ type: "content_block_stop", index: toolInfo.blockIndex });
}
```

## Acceptance criteria

- `sanitizeToolArgs` lives in exactly one place; both `openai-to-claude.js` and `kiro-to-claude.js` import it.
- A new test in `tests/translator/claude-kiro-direct.test.js` verifies that buffering tool args `'{"file_path":"/x.txt","limit":"100","offset":"-5"}'` over multiple chunks and finishing produces a single `input_json_delta` with `partial_json` containing `"limit":100` and `"offset":0` (the sanitizer's clamp behavior).
- A second test verifies a non-`Read` tool's args are passed through unchanged (sanitizer is opt-in by tool name).
- `pnpm vitest run tests/translator/` is green.
- Pivot path tests (whatever currently exercises `openai-to-claude.js` tool sanitization) continue to pass without modification — the refactor is structural.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
```

## Why this matters

This is the only finding from the PR audit that is a **clear functional regression**, not just a divergence. Without this, switching a request from pivot to direct can change tool-call payload semantics in ways the user can't predict.

## Reference

- Pivot sanitizer source: `open-sse/translator/response/openai-to-claude.js:5-41` (the `CLAUDE_OAUTH_TOOL_PREFIX` constant and `sanitizeToolArgs`/`sanitizeReadArgs`/`isValidPdfPagesArg` block).
- PR audit thread for context.
