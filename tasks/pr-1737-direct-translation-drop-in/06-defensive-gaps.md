# Task 06 — Defensive gaps and minor parity issues

**Priority:** P2 (post-merge polish)
**Files:** `claude-to-kiro.js`, `kiro-to-claude.js`

## Problem

Several small parity gaps the audit caught. Each is independently small; group them in one PR.

### 6a. Missing image source guard

`claude-to-kiro.js:272-275` (in the user-content extraction loop):

```js
} else if (block.type === "image" && block.source?.type === "base64") {
  const mediaType = block.source.media_type || "image/png";
  const format = mediaType.split("/")[1] || mediaType;
  pendingImages.push({ format, source: { bytes: block.source.data } });
}
```

This pushes `block.source.data` even when it's `undefined` (malformed input). Pivot path guards: `openai-to-kiro.js:300-307` checks `c.source?.data` exists.

**Fix:** Add the same guard.

```js
} else if (block.type === "image" && block.source?.type === "base64" && block.source.data) {
```

### 6b. Anthropic image URL form silently dropped

The Anthropic Messages API now also accepts:

```json
{ "type": "image", "source": { "type": "url", "url": "https://..." } }
```

Both translators currently ignore this branch. Kiro doesn't accept URL images; pivot path falls back to `[Image: <url>]` text (`openai-to-kiro.js:296-299`). Direct path drops silently.

**Fix:** Add a fallback that converts URL-form Claude images to a `[Image: <url>]` text marker, appended to the user content. Mirrors what `openai-to-kiro.js` does for `image_url` with non-base64 data.

```js
} else if (block.type === "image" && block.source?.type === "url" && block.source.url) {
  const urlMarker = `[Image: ${block.source.url}]`;
  pendingUserContent.push(urlMarker);
}
```

### 6c. Message-id length-fallback missing

`kiro-to-claude.js:636-638`:

```js
state.messageId =
  (typeof data.id === "string" && data.id.replace("chatcmpl-", "")) ||
  `msg_${Date.now()}`;
```

Pivot has a length check (`openai-to-claude.js:110-114`):

```js
if (!state.messageId || state.messageId === "chat" || state.messageId.length < 8) {
  state.messageId = chunk.extend_fields?.requestId ||
    chunk.extend_fields?.traceId ||
    `msg_${Date.now()}`;
}
```

Today, `KiroExecutor` always emits `chatcmpl-${Date.now()}` so the truncated id will be 13+ chars and harmless. But the cheapness of mirroring is < 5 lines, and it costs nothing to keep parity.

**Fix:** Copy the length-fallback block from `openai-to-claude.js`.

### 6d. `proxy_` tool-name prefix not stripped

`openai-to-claude.js:189-203` strips a `proxy_` prefix (Claude OAuth cloaking artifact — see `9router-development/open-sse/utils/claudeCloaking.js`):

```js
let toolName = tc.function?.name || "";
if (toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
  toolName = toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length);
}
// ... and uses `toolName` (not `tc.function.name`) in content_block_start
```

Direct path uses `tc.function?.name || ""` raw at `kiro-to-claude.js:707-720`.

Kiro shouldn't emit `proxy_`-prefixed tool names today (cloaking is applied request-side for Claude provider, not Kiro). But for true parity and future-proofing:

**Fix:** Import `CLAUDE_OAUTH_TOOL_PREFIX` from the helper introduced in task 01, and strip in the same way before stashing in `state.toolCalls` and emitting `content_block_start`.

### 6e. Assistant `thinking` block ignored on inbound

`claude-to-kiro.js:300-313`: assistant message extraction handles `text` and `tool_use` blocks but not `thinking` blocks. If a client echoes an assistant turn with thinking content from a prior response (Anthropic interleaved thinking flow), it's silently dropped.

Pivot path also drops them, so this isn't a regression — but it's a known limitation. Either:

- Drop the extension to a follow-up task and just add a `// TODO: handle thinking blocks if Anthropic flips them on by default` comment, **or**
- Concat thinking into a single text segment at the start of the assistant turn (not perfect but doesn't lose data).

For this task: just add the comment. Real handling is a separate decision.

## Acceptance criteria

- 6a: Test verifies an image block with `{source: {type: "base64"}}` (no `data`) doesn't push an empty image entry.
- 6b: Test verifies a URL-form image block produces `[Image: ...]` text in user content, no error.
- 6c: Test verifies a chunk with `id: "chat"` upgrades to `extend_fields.requestId` if present, else `msg_${Date.now()}`.
- 6d: Test verifies a tool_call with `name: "proxy_search"` produces a Claude `tool_use` with `name: "search"` (matching pivot).
- 6e: TODO comment present, no behavior change.
- `pnpm vitest run tests/translator/` green.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
```

## Why this matters

Each item alone is small. Together, they close the visible deltas between pivot and direct so the codebase has one consistent contract.

## Reference

- Pivot guards: `open-sse/translator/request/openai-to-kiro.js:296-307`, `:289-294`.
- Pivot id-fallback: `open-sse/translator/response/openai-to-claude.js:110-114`.
- Pivot prefix-strip: `open-sse/translator/response/openai-to-claude.js:189-203`.
- OAuth cloaking source: `open-sse/utils/claudeCloaking.js` (search for `CLAUDE_OAUTH_TOOL_PREFIX` or the cloaking entry in `index.js:127-135`).
