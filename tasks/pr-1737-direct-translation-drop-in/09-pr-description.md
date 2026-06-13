# Task 09 — Fix the PR description

**Priority:** P2 (hygiene)
**Where:** GitHub PR https://github.com/decolua/9router/pull/1737 description body

## Problem

The PR body claims:

> - **stream:** env-overridable first-chunk (TTFT) vs stall timeouts and a Kiro keepalive frame so slow prefill is not aborted mid-stream.

Neither of those changes is in the PR diff:

- `STREAM_FIRST_CHUNK_TIMEOUT_MS` / `STREAM_STALL_TIMEOUT_MS` already live in `9router-development/open-sse/utils/streamHandler.js` (lines 197-208). They were introduced in commit `7a8fa81 fix(sse): prevent false stall aborts on large-context reasoning streams`, well before this PR.
- The Kiro keepalive `: ka\n\n` frame already lives in `9router-development/open-sse/executors/kiro.js` (lines 381-383), also pre-existing.

Misattributing existing work in a PR description weakens reviewer trust on the parts that are genuinely new.

## Fix

Edit the PR body. Drop the bullet about TTFT/stall timeouts and the Kiro keepalive. The remaining bullets are accurate.

Suggested cleaned body:

```
feat(kiro): direct Claude<->Kiro translation route

Adds a direct claude:kiro request and kiro:claude response translator so
Anthropic Messages API traffic to Kiro (AWS CodeWhisperer) no longer pivots
through the OpenAI format. translateRequest/translateResponse now check for a
translator registered on the exact source:target pair before falling back to
the OpenAI two-hop.

- claude-to-kiro.js: builds the Kiro conversationState payload straight from
  Claude messages, carrying over the two "Improperly formed request" 400 guards
  (flatten tool interactions when no tools; reconcile orphaned tool_results)
  plus -agentic/-thinking suffix + thinking-mode handling.
- kiro-to-claude.js: converts the OpenAI-shaped chunks KiroExecutor emits into
  Claude SSE events (text, thinking, tool_use, usage).
- index.js: direct-route lookup ahead of the OpenAI pivot in both directions.
- tests: claude-kiro-direct.test.js covering both routes and the 400 guards.
```

## Acceptance criteria

- PR description no longer mentions TTFT/stall timeouts or Kiro keepalive.
- The remaining bullets accurately describe what's in the diff.

## How to verify

```bash
gh pr view 1737 --repo decolua/9router --json body --jq .body
```

Compare against `gh pr diff 1737 --repo decolua/9router | grep -E '^\+\+\+ '`.

## Why this matters

Five-minute fix. Costs nothing. Keeps reviewer trust intact.

## Reference

- Stream timeout source: `open-sse/utils/streamHandler.js:188-224`.
- Keepalive frame source: `open-sse/executors/kiro.js:379-383`.
- Original commit for the timeout work: `git log --oneline -- open-sse/utils/streamHandler.js | head -5` (look for `7a8fa81`, `52bcca6`, or similar `fix(sse)` entries).
