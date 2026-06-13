# Task 02 — Match `max_tokens` behavior with the OpenAI pivot

**Priority:** P0 (blocks merge — silent semantic divergence)
**File:** `9router-development/open-sse/translator/request/claude-to-kiro.js`

## Problem

The pivot's `openai-to-kiro.js:514` hardcodes:

```js
const maxTokens = 32000;
```

It ignores `body.max_tokens` entirely.

The new direct translator `claude-to-kiro.js:456` does:

```js
const maxTokens = body.max_tokens || 32000;
```

A Claude client sending `max_tokens: 4096` (the SDK default) will now forward 4096 to Kiro on the direct route but 32000 on the pivot route. Same input, different upstream behavior depending on which route is active. That fails the drop-in contract.

## Fix

Pick one of:

### Option A — Match the pivot (recommended for this PR)

```js
const maxTokens = 32000; // matches openai-to-kiro pivot; ignore body.max_tokens
```

This is the byte-equivalent choice. Ship #1737 with parity, then change both translators in a follow-up PR if you want to honor the client value.

### Option B — Honor the client (riskier)

Change `openai-to-kiro.js:514` in the same PR so both paths read `body.max_tokens || 32000`. This means **every** client that previously got the 32000 ceiling now gets whatever they sent, which can include very small caps that truncate responses. Needs a deliberate rollout.

The default for this task is **Option A**. If you choose Option B, get sign-off first and update task 03's acceptance test accordingly.

## Acceptance criteria

- `claude-to-kiro.js` and `openai-to-kiro.js` agree byte-for-byte on `inferenceConfig.maxTokens` for the same input request.
- A new test in `tests/translator/claude-kiro-direct.test.js` verifies that `{messages: [...], max_tokens: 1024}` produces `inferenceConfig.maxTokens === 32000` (or whatever Option A enforces).
- `pnpm vitest run tests/translator/` is green.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
```

Manual sanity check: send a Claude request with `max_tokens: 100` through both routes (toggle the route via task 04's flag once it lands, or temporarily comment the direct-route lookup in `index.js`), and confirm Kiro receives the same value.

## Why this matters

Silent divergence in `max_tokens` is the most likely thing to surface as a bug report ("my responses got cut off after we deployed PR #1737"). Catching it pre-merge is much cheaper than diagnosing it post-incident.

## Reference

- Pivot: `open-sse/translator/request/openai-to-kiro.js:511-578` (`buildKiroPayload`).
- Direct: `open-sse/translator/request/claude-to-kiro.js:452-545` (`claudeToKiroRequest`).
