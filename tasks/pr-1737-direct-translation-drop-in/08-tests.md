# Task 08 — Add the missing test coverage

**Priority:** P1 (recommended before merge)
**File:** `9router-development/tests/translator/claude-kiro-direct.test.js` (extend existing)

## Problem

The existing test file (`claude-kiro-direct.test.js`) covers:

- Basic Claude→Kiro payload shape
- The two 400-guards (`flattenClaudeToolInteractions`, orphan tool_results)
- Thinking suffix → `<thinking_mode>` injection
- Basic Kiro→Claude SSE happy path (text, finish, reasoning, tool_calls)

It does **not** cover:

1. Image (base64) propagation through the direct request path.
2. `body.system` placement (will need this once task 03 lands).
3. `-agentic` suffix → `KIRO_AGENTIC_SYSTEM_PROMPT` injection.
4. Multi-turn alternation with role merging.
5. Buffered multi-chunk tool-call args sanitized on finish (regression test for task 01).
6. SSE keepalive `: ka\n\n` frames don't break the response translator.
7. Direct vs pivot equivalence (the actual drop-in contract).
8. Response state-machine: ordering when reasoning interleaves with text.

## Tests to add

Add to `tests/translator/claude-kiro-direct.test.js` (or a new sibling file `claude-kiro-direct-coverage.test.js` if the first one gets unwieldy).

### 8.1 — Image propagation

```js
it("forwards a base64 image to currentMessage.images", () => {
  const out = C2K({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    }],
  });
  const cur = out.conversationState.currentMessage.userInputMessage;
  expect(cur.images).toEqual([{ format: "png", source: { bytes: "AAAA" } }]);
});
```

### 8.2 — `body.system` lands in history (depends on task 03)

```js
it("puts body.system at the start of history (parity with pivot)", () => {
  const out = C2K({
    system: "You are an XML emitter.",
    messages: [{ role: "user", content: "go" }],
  });
  const firstHist = out.conversationState.history[0]?.userInputMessage?.content || "";
  expect(firstHist).toContain("You are an XML emitter.");
  // System content does NOT appear in currentMessage (only the prefixes do).
  const cur = out.conversationState.currentMessage.userInputMessage.content;
  expect(cur).not.toContain("You are an XML emitter.");
});

it("body.system as Array<{type, text}> joins correctly", () => {
  const out = C2K({
    system: [{ type: "text", text: "rule 1" }, { type: "text", text: "rule 2" }],
    messages: [{ role: "user", content: "go" }],
  });
  const firstHist = out.conversationState.history[0]?.userInputMessage?.content || "";
  expect(firstHist).toContain("rule 1");
  expect(firstHist).toContain("rule 2");
});
```

### 8.3 — `-agentic` suffix injects the system prompt

```js
it("agentic suffix injects KIRO_AGENTIC_SYSTEM_PROMPT into prefix", () => {
  const out = translateRequest(
    FORMATS.CLAUDE, FORMATS.KIRO, "claude-sonnet-4.5-agentic",
    { messages: [{ role: "user", content: "hi" }] }, true, null, "kiro"
  );
  const cur = out.conversationState.currentMessage.userInputMessage.content;
  expect(cur).toContain("CHUNKED WRITE PROTOCOL"); // marker text from KIRO_AGENTIC_SYSTEM_PROMPT
});
```

### 8.4 — Multi-turn with role merging and tool_result orphan

```js
it("merges consecutive user turns and reconciles orphans across history+current", () => {
  const out = C2K({
    tools: [{ name: "f", description: "fn", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "user", content: "step 1" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "salvage" }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "step 3" },
    ],
  });
  // No orphan structured ref anywhere
  const allItems = [...out.conversationState.history, out.conversationState.currentMessage];
  for (const it of allItems) {
    const tr = it?.userInputMessage?.userInputMessageContext?.toolResults || [];
    expect(tr.length).toBe(0);
  }
  // Salvaged content lives somewhere as text
  const allText = allItems
    .map(it => it?.userInputMessage?.content || "")
    .join("\n");
  expect(allText).toContain("salvage");
});
```

### 8.5 — Tool-arg sanitization (regression test for task 01)

```js
it("sanitizes Read.limit string-numeric and clamps via the shared helper", () => {
  const state = {};
  // First chunk opens the tool_use
  R(
    {
      id: "c", object: "chat.completion.chunk", model: "m",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tu1", type: "function", function: { name: "Read", arguments: "" } }] }, finish_reason: null }],
    },
    state
  );
  // Buffered args
  R(
    {
      id: "c", object: "chat.completion.chunk", model: "m",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":"/a","limit":"100","offset":"-5"}' } }] }, finish_reason: null }],
    },
    state
  );
  const events = R(
    {
      id: "c", object: "chat.completion.chunk", model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
    state
  );
  const jsonDelta = events.find(
    (e) => e.type === "content_block_delta" && e.delta.type === "input_json_delta"
  );
  expect(jsonDelta).toBeTruthy();
  const parsed = JSON.parse(jsonDelta.delta.partial_json);
  expect(parsed.limit).toBe(100);   // string → number
  expect(parsed.offset).toBe(0);    // negative → 0
});
```

### 8.6 — Keepalive SSE comment doesn't crash translator

```js
it("string keepalive `: ka` frame returns null without throwing", () => {
  const state = {};
  // Direct route receives objects, but tolerate strings (existing defensive branch)
  const out = R(": ka", state);
  expect(out).toEqual([]); // translateResponse normalizes null → []
});
```

(Verify what `translateResponse` returns for a `null` direct-route result: see `index.js:171-175` in the PR diff — it returns `[]`.)

### 8.7 — Direct vs pivot equivalence

```js
it("produces a Kiro payload equivalent to the pivot route (modulo conversationId)", () => {
  const body = {
    system: "be brief",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "more" },
    ],
    max_tokens: 1024,
  };
  const direct = C2K(body);
  // Build the pivot equivalent: claude → openai → kiro
  const claudeToOpenai = require("../../open-sse/translator/request/claude-to-openai.js");
  // ... or call translateRequest with a stubbed direct registry to force pivot
  // (this may need help from task 04's flag)
  // expect(stripIds(direct)).toEqual(stripIds(pivot));
});
```

If task 04 has landed, use its env flag to force pivot. Otherwise this test is best added in the same PR as task 04.

### 8.8 — Reasoning interleaved with text closes blocks correctly

```js
it("reasoning then text emits content_block_stop on the thinking block before opening text", () => {
  const state = {};
  R({ id: "c", object: "chat.completion.chunk", model: "m",
      choices: [{ index: 0, delta: { reasoning_content: "ponder" }, finish_reason: null }] }, state);
  const events = R({ id: "c", object: "chat.completion.chunk", model: "m",
      choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }, state);
  const stopIdx = events.findIndex(e => e.type === "content_block_stop");
  const textStartIdx = events.findIndex(e => e.type === "content_block_start" && e.content_block.type === "text");
  expect(stopIdx).toBeGreaterThan(-1);
  expect(textStartIdx).toBeGreaterThan(stopIdx);
});
```

## Acceptance criteria

- All eight tests above are present and passing.
- `pnpm vitest run tests/translator/` green.
- No flakiness — run the suite three times locally to confirm.
- The test file remains readable; if it grows past ~400 lines, split off a `claude-kiro-direct-coverage.test.js`.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
# Or watch while iterating:
pnpm vitest watch tests/translator/
```

## Why this matters

The existing tests prove the architecture works. The tests above prove it stays working as the surrounding code evolves. The pivot vs direct equivalence test (8.7) is the single most valuable one — it's what enforces "drop-in" automatically.

## Reference

- Existing test layout: `tests/translator/claude-kiro-direct.test.js`.
- Test register hook: `tests/translator/registerAll.js`.
- Vitest config: `9router-development/package.json` test scripts.
