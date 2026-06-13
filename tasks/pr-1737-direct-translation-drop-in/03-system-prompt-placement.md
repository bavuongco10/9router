# Task 03 — Place `body.system` in history (matching pivot), not on `currentMessage`

**Priority:** P0 (blocks merge — semantic divergence on multi-turn)
**File:** `9router-development/open-sse/translator/request/claude-to-kiro.js`

## Problem

The pivot path naturally puts the Claude `system` prompt at the **start of conversation history**, because:

1. `claude-to-openai.js` converts `body.system` to a leading `role: "system"` message.
2. `openai-to-kiro.js` normalizes `system → user` (`openai-to-kiro.js:268-270`) and merges it with the first user turn.
3. Result: system text becomes the first user-history entry. It appears once, at the top.

The new direct path (`claude-to-kiro.js:488-505`) prepends `body.system` to **`currentMessage.content` only**, after the thinking/timestamp/agentic prefixes. For multi-turn requests this means:

- The system prompt now rides on every turn's currentMessage, not just at the start of history.
- The prefix order nests system *inside* the agentic prompt wrapping, which is also not what the pivot does.

This is a semantic divergence: identical multi-turn input produces different upstream payloads on the two routes.

The Quorinex/Kiro-Go reference (`proxy/translator.go:254-271` in the `ClaudeToKiro` function) does it cleanly: extracts the system prompt, then prepends a synthetic `[user: <system>] / [assistant: "I will follow these instructions."]` priming pair to history. We can borrow the simpler "synthetic leading user message" approach, which is what the existing pivot effectively produces.

## Fix

In `claude-to-kiro.js`, inside `claudeToKiroRequest`, before calling `convertClaudeMessagesToKiro`:

```js
let messages = Array.isArray(body.messages) ? body.messages : [];
const tools = Array.isArray(body.tools) ? body.tools : [];

// Inject body.system as a synthetic leading user message so it lands in
// history (matching the pivot path). Do this BEFORE the tool-flatten guard
// so the synthetic message gets the same treatment.
if (body.system) {
  let sysText = "";
  if (typeof body.system === "string") {
    sysText = body.system;
  } else if (Array.isArray(body.system)) {
    sysText = body.system.map((s) => s?.text || "").filter(Boolean).join("\n");
  }
  if (sysText) {
    messages = [{ role: "user", content: sysText }, ...messages];
  }
}
```

Then **remove** the later `if (body.system) { … finalContent = `${systemText}\n\n${finalContent}`; }` block (currently `claude-to-kiro.js:488-497`). The prefix builder for `<thinking_mode>`, timestamp, and `KIRO_AGENTIC_SYSTEM_PROMPT` stays as it is — those are 9router-synthetic prefixes that *should* prepend to currentMessage on every turn, system prompt is not.

## Edge cases to handle

- Empty `body.system` (`""`, `null`, `[]`) → no synthetic message inserted. Already covered by the `if (sysText)` guard.
- `body.system` as `Array<{type: "text", text: "..."}>` → join `text` fields with `\n` (already the existing extraction logic, just relocated).
- A request that has zero `body.messages` and only `body.system`: the synthetic message becomes the first turn → currentMessage. That matches what the pivot would do (claude-to-openai produces a single system message; openai-to-kiro would normalize it to a user turn and pop it as currentMessage).

## Acceptance criteria

- A test verifies that `{system: "S", messages: [{role: "user", content: "hi"}]}` produces a Kiro payload where:
  - `history[0].userInputMessage.content` starts with the system text `"S"`.
  - `currentMessage.userInputMessage.content` does **not** contain `"S"` (only the prefixes + `"hi"`).
- A test verifies multi-turn: `{system: "S", messages: [{user:"a"}, {assistant:"b"}, {user:"c"}]}` produces:
  - history starts with system → "a" → assistant "b" (or however the merge logic plays out)
  - currentMessage is "c" with prefixes, no system
- A test verifies `system` as an array of text blocks joins correctly.
- A test verifies empty `system` (string, array, null) inserts no synthetic message.
- Comparing the Kiro payload from the direct route vs the pivot route for an identical Claude input request produces identical `conversationState.history[*].userInputMessage.content` (modulo the conversationId UUID).
- `pnpm vitest run tests/translator/` green.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
```

For the pivot-vs-direct equivalence test, you can do it within one test by translating the same request twice and `expect(directResult).toEqual(pivotResult)` after stripping `conversationId`.

## Why this matters

System prompts are how clients communicate persistent constraints (tool whitelists, output format rules, persona). If those constraints get re-injected on every turn instead of once at the top, models behave differently — sometimes subtly, sometimes badly. The pivot's behavior is the de facto contract; the direct route must preserve it.

## Reference

- Pivot system→user normalization: `open-sse/translator/request/openai-to-kiro.js:264-270`.
- Direct prepend block to remove: `claude-to-kiro.js:488-497`.
- Kiro-Go's priming approach: https://github.com/Quorinex/Kiro-Go `proxy/translator.go` lines 254-271 (`ClaudeToKiro`, `priming`).
