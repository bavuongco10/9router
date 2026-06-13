# Task 11 — Claude content-block fidelity bugs

**Priority:** P1 (real fidelity bugs — silent loss of meaning, not crashes)
**File:** `9router-development/open-sse/translator/request/claude-to-kiro.js`

## Problem

Real Claude clients (Claude Code in particular — see https://github.com/Tinkeringg-Lab/claude-code `src/QueryEngine.ts` for a representative example) send content-block shapes the new direct translator drops or mistranslates. Each is a fidelity bug: the request doesn't error, but the upstream model receives different context than the client sent. Four cases, all in `claude-to-kiro.js`.

### 11a. `is_error: true` on tool_result is mapped to "success"

`claude-to-kiro.js:289-293`:

```js
pendingToolResults.push({
  toolUseId: block.tool_use_id,
  status: "success",   // hardcoded — ignores block.is_error
  content: [{ text: resultContent }],
});
```

Anthropic tool_result blocks carry `is_error: true` to signal that the tool itself failed. Kiro's `toolResults[].status` accepts `"success" | "error"`. Mapping a Claude-side errored tool result to Kiro `status: "success"` lies to the model — it thinks the tool worked.

**Fix:**

```js
pendingToolResults.push({
  toolUseId: block.tool_use_id,
  status: block.is_error === true ? "error" : "success",
  content: [{ text: resultContent }],
});
```

Mirror the same change in `openai-to-kiro.js:319-323` (which currently also hardcodes `status: "success"`) for parity — it doesn't propagate the OpenAI tool message's error state either, but that's a separate bug; document and fix in this same PR if scope allows.

### 11b. `role: "system"` messages in messages array silently dropped

The mid-conversation-system beta (`mid-conversation-system-2026-04-07`) lets clients place `{role: "system", ...}` between user and assistant turns in `messages[]`, on Opus 4.6+ and Sonnet 4.6. It carries operator-authority context (mode switches, mid-session rules, async-fetched context). `convertClaudeMessagesToKiro` only branches on `role === "user"` and `role === "assistant"`:

```js
if (role === "user") { ... } else if (role === "assistant") { ... }
// system role: falls through, lost
```

**Fix:** treat as user content with a marker, matching what the pivot path effectively does (claude-to-openai produces `role: "system"` → openai-to-kiro normalizes system → user):

```js
} else if (role === "system") {
  // mid-conversation-system beta — collapse to user content with a marker.
  // Mirrors the pivot path's claude→openai→kiro normalization.
  if (currentRole !== "user" && currentRole !== null) flushPending();
  currentRole = "user";
  let text = "";
  if (typeof msg.content === "string") {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content.map((c) => c?.text || "").filter(Boolean).join("\n");
  }
  if (text) pendingUserContent.push(`[System: ${text}]`);
}
```

### 11c. Thinking blocks in assistant history silently dropped

`claude-to-kiro.js:300-313` extracts assistant content:

```js
for (const block of msg.content) {
  if (block.type === "text") { textContent += block.text; }
  else if (block.type === "tool_use") { toolUses.push(...); }
  // thinking / redacted_thinking / server_tool_use: silently dropped
}
```

Multi-turn requests on adaptive-thinking models echo back the prior assistant turn's `thinking` blocks (Anthropic SDK best practice — preserves continuity for the model). Kiro's `assistantResponseMessage` doesn't accept thinking back, so the right call is to **fold the thinking text into the assistant's content** rather than drop silently:

```js
} else if (block.type === "thinking" && block.thinking) {
  textContent += `\n[Previous thinking: ${block.thinking}]\n`;
}
// `redacted_thinking` blocks are encrypted — no surface; drop with a comment.
```

Pivot path also drops thinking blocks (claude-to-openai doesn't preserve them either), so this is strictly an improvement on both routes if you choose to keep it. Alternatively: drop with a TODO comment and ship parity with pivot. Either way, make the choice explicit in code.

### 11d. Server-side tool blocks in assistant history not handled

`server_tool_use`, `web_search_tool_result`, `code_execution_tool_result`, `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`, `fallback` — Anthropic emits these when prior turns used server-side tools or fallback fired. They survive in conversation history. Currently fall through silently.

**Fix:** explicit drop with a comment so the next reader knows it was deliberate, not an oversight:

```js
} else if (
  block.type === "server_tool_use" ||
  block.type === "web_search_tool_result" ||
  block.type === "web_fetch_tool_result" ||
  (typeof block.type === "string" && block.type.endsWith("_code_execution_tool_result")) ||
  block.type === "fallback"
) {
  // Server-side tool / fallback blocks have no Kiro equivalent — drop.
  // The adjacent text block usually conveys the user-visible result.
}
```

## Acceptance criteria

- 11a: Test verifies a `tool_result` with `is_error: true` produces a Kiro `toolResults` entry with `status: "error"`. Default (no `is_error`) still maps to `"success"`.
- 11b: Test sends `[{role: "user", content: "a"}, {role: "system", content: "rule"}, {role: "user", content: "b"}]` and verifies the resulting Kiro currentMessage / history user content contains both `"a"`, `[System: rule]`, and `"b"` (merged) and no message is lost.
- 11c: Test sends an assistant turn with a `thinking` block followed by a text block, verifies the resulting `assistantResponseMessage.content` contains both the thinking marker and the text.
- 11d: Test sends an assistant turn with a `server_tool_use` block adjacent to a text block, verifies the assistantResponseMessage carries the text (the server-side block is dropped without crashing).
- `pnpm vitest run tests/translator/` green.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
```

## Why this matters

11a is the most clearly buggy — translating a failure as success can change downstream behavior in user-visible ways. 11b matters because the mid-conversation-system beta is a real Claude SDK feature on 4.6+ models; clients using it via direct route lose those messages entirely. 11c/11d are smaller (Kiro can't use them anyway), but the explicit drop makes the limitation obvious to the next maintainer.

## References

- Anthropic tool_result `is_error`: standard Messages API field, see `shared/tool-use-concepts.md` in the claude-api skill.
- Mid-conversation-system beta: `mid-conversation-system-2026-04-07`. Anthropic-side spec covered in `shared/prompt-caching.md` § Mid-conversation system messages.
- Server-side tool block types: `shared/tool-use-concepts.md` § Server-Side Tools (code execution, web search, web fetch, computer use).
- Direct translator code: `open-sse/translator/request/claude-to-kiro.js:267-313`.
- Pivot translator (parity check): `open-sse/translator/request/openai-to-kiro.js:278-330`.
