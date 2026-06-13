# Task 10 — Patterns from Quorinex/Kiro-Go worth borrowing

**Priority:** P2 (optional, post-merge)
**Reference:** https://github.com/Quorinex/Kiro-Go (`proxy/translator.go`)

## Problem

The user pointed at Kiro-Go as a second reference implementation. Reading its `ClaudeToKiro` and `KiroToClaudeResponse` revealed several patterns 9router could adopt. None are required for drop-in parity (tasks 01-09 cover that), but they would harden the implementation.

## Patterns to consider

### 10a. History-resident system priming (synthetic user→assistant pair)

Kiro-Go puts the system prompt into history as a two-message priming pair (`proxy/translator.go:254-271`):

```go
priming := []KiroHistoryMessage{
  { UserInputMessage: &KiroUserInputMessage{Content: systemPrompt, ...} },
  { AssistantResponseMessage: &KiroAssistantResponseMessage{
      Content: "I will follow these instructions." } },
}
history = append(priming, history...)
```

Task 03 already adopts the "system as leading user message" half. The "and then a stub assistant ack" half is a separate refinement: it gives the model an explicit acknowledgment turn, which some upstream implementations behave better with. Worth A/B-testing post-merge to see if it changes Kiro response quality.

**If adopted:** add to `claude-to-kiro.js` after the synthetic-user-message insertion in task 03.

### 10b. Conversation ID derived from content (deterministic)

Kiro-Go computes `conversationId` as a hash of `(modelID, systemPrompt, firstUserMessage)` (`proxy/translator.go:309`, `buildConversationID` at `:1818`). 9router uses `uuid.v4()` (random) every request.

Trade-off:
- **Random (current):** Each request is a new conversation upstream — no chance of accidental cross-contamination, but also no chance of upstream caching.
- **Deterministic:** Repeat requests with identical priming hit the same upstream conversationId, which can let Kiro/CodeWhisperer reuse computation (or maybe not — Kiro's caching semantics aren't documented).

Probably safer to stay on UUIDs unless there's a concrete signal Kiro caches by conversationId. **Don't adopt without measurement.**

### 10c. Payload truncation to a context-window limit

Kiro-Go has `truncatePayloadToLimit(payload, hasPriming)` (`proxy/translator.go:1624`) which trims history to fit within a Kiro context window (`maxConversationHistoryTokens`). Strategy: keep system priming + most recent N turns + active tool turn.

9router has no equivalent. Long conversations either succeed (Kiro accepts them) or fail with a 400 from upstream. A truncation pass would degrade gracefully instead of failing.

**If adopted:** new helper in `9router-development/open-sse/translator/helpers/`, used by both `claude-to-kiro.js` and `openai-to-kiro.js`. Needs a token estimator (Kiro-Go uses `proxy/token_estimator.go`). Non-trivial; punt to a follow-up task with its own design discussion.

### 10d. Prompt filters for Claude Code CLI noise

Kiro-Go detects when the inbound system prompt is the Claude Code CLI's built-in prompt (`isClaudeCodeSystemPrompt`, `proxy/translator.go:490`) and replaces it with a minimal backend prompt (`claudeCodeBackendPrompt`, `proxy/translator.go:482-486`). It also strips `# Environment` / `# auto memory` sections, `gitStatus:` lines, fast-mode tags, etc. (`stripEnvNoiseLines`, `proxy/translator.go:439`).

Reasoning: when 9router serves Claude Code CLI users, the system prompt that arrives includes a lot of CLI-specific instructions ("you are claude code", environment metadata) that pollute Kiro's context and bias the model away from being a clean backend.

**If adopted:** new helper called from `buildClaudeSystemPrompt` (which would need to be added to 9router — task 03 introduces a synthetic user message but doesn't filter it). Worth doing if 9router serves significant Claude Code CLI traffic.

### 10e. Tool description length cap

Kiro-Go truncates tool descriptions to 10237 chars (`maxToolDescLen`, `proxy/translator.go:197`). Kiro likely 400s on overly-long descriptions; this prevents that.

**If adopted:** add a length check in `claude-to-kiro.js`'s `buildToolSpecs` and `openai-to-kiro.js`'s tool conversion. Cheap, defensive.

### 10f. Tool result image placeholder

Kiro-Go has `toolResultImagePlaceholder = "[Tool returned an image; the image is attached to this message.]"` (`proxy/translator.go:47`). When a tool result contains an image (tool_result.content with image blocks), Kiro-Go replaces the image with a placeholder text and attaches the actual image bytes to the user message's `images` field.

9router currently only handles `tool_result.content` of type text. If a tool returns an image (e.g., a screenshot tool), 9router silently drops it.

**If adopted:** extend `toolResultBlockToText` and the user-content extraction in both translators. Moderate complexity; depends on how often tool-result images come up in practice.

## Recommendation

For an opportunistic improvement pass:

- **Adopt:** 10e (tool description length cap) — cheap, defensive, removes a real 400 trigger.
- **Investigate:** 10d (Claude Code CLI prompt filtering) — only if telemetry shows significant Claude Code CLI usage on Kiro routes.
- **Skip for now:** 10a, 10b, 10c, 10f — each needs its own design discussion.

## Acceptance criteria

This task is informational. To "complete" it, decide which subtasks (10a-f) to spin out into their own task files in this directory, or close it as "reviewed, no immediate action."

## How to verify

Read the Kiro-Go source linked above and form your own opinion. The summaries here are accurate as of 2026-06-11 but the upstream may evolve.

## Reference

- Kiro-Go translator: https://github.com/Quorinex/Kiro-Go/blob/main/proxy/translator.go
- Kiro-Go handler (Claude SSE producer): https://github.com/Quorinex/Kiro-Go/blob/main/proxy/handler.go (search `handleClaudeStream`).
