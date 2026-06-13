# Task 07 — Forward `stop_sequences`; document `tool_choice` limitation

**Priority:** P2 (post-merge polish)
**File:** `9router-development/open-sse/translator/request/claude-to-kiro.js` (and same change in `openai-to-kiro.js` for symmetry)

## Problem

Both the pivot and the direct path drop two Claude/OpenAI request fields that Kiro can or could approximate:

### 7a. `stop_sequences` is dropped

Anthropic Messages API supports `stop_sequences: ["foo", "bar"]`. Kiro's `inferenceConfig` accepts `stopSequences`. Today neither translator forwards them.

**Fix in `claude-to-kiro.js`:**

```js
if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
  payload.inferenceConfig ||= {};
  payload.inferenceConfig.stopSequences = body.stop_sequences;
}
```

For full parity, mirror the change in `openai-to-kiro.js` (OpenAI Chat Completions uses `stop`, accepts string or array). Translate to a uniform array.

### 7b. `tool_choice` is dropped

Anthropic supports `tool_choice: "auto" | "any" | {type: "tool", name: "X"}`. Kiro has no direct equivalent — the upstream model decides whether to call tools.

The closest approximation is to inject a system-prompt-style hint when `tool_choice` is restrictive:

- `"any"` → append `"You MUST call one of the available tools."` to the prefix
- `{type: "tool", name: "X"}` → append `"You MUST call the tool named X."`
- `"auto"` and `"none"` → no-op (no need to nudge)

This is a heuristic, not a guarantee. Document it as such.

**Fix:** For this task, **only document the limitation** in a comment in `claude-to-kiro.js`. Don't ship the heuristic without sign-off. Wording suggestion:

```js
// Kiro has no native equivalent of Claude's tool_choice. We pass tools through
// and let the upstream model decide. If a stricter contract becomes necessary,
// the established workaround is to inject "You MUST call tool X" into the
// system-prompt prefix — but that's a probabilistic nudge, not a guarantee,
// and we don't ship it by default.
```

If the heuristic is desired, open a follow-up task; it touches the prefix-builder block (currently `claude-to-kiro.js:499-505`).

## Acceptance criteria

- 7a: A test verifies that `{messages: [...], stop_sequences: ["END"]}` produces a Kiro payload with `inferenceConfig.stopSequences === ["END"]`.
- 7a: Same test for empty/missing `stop_sequences` produces no `stopSequences` field.
- 7a: Mirror change in `openai-to-kiro.js` for `body.stop` (handle both string and array forms).
- 7b: TODO comment present in `claude-to-kiro.js`.
- `pnpm vitest run tests/translator/` green.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
```

## Why this matters

Stop sequences are a real feature clients use (e.g., to constrain JSON-mode outputs to a specific token). Today they're silently lost. Tool-choice is more contentious but worth documenting so the next reader understands the gap is intentional.

## Reference

- Anthropic stop sequences: well-known field on the Messages API.
- Kiro `inferenceConfig` shape: see `claude-to-kiro.js:531-536` and `openai-to-kiro.js:566-572`.
- Tool choice docs (Anthropic) — well-known semantics; the workaround is a community pattern, not provider-supported.
