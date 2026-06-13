# Task 04 — Add an emergency rollback flag for the direct route

**Priority:** P1 (recommended before merge)
**File:** `9router-development/open-sse/translator/index.js`

## Problem

PR #1737 activates the direct `claude:kiro` and `kiro:claude` routes the moment both translators are registered. There's no runtime knob to flip back to the pivot if a regression appears in production. The pivot is well-exercised; the direct route is brand new. You want a safety hatch that doesn't require a code deploy.

## Fix

Add an env-var check in `translateRequest` and `translateResponse` so the direct-route lookup can be disabled at process start. Default behavior unchanged (direct route active when both translators registered).

### Request side (`translateRequest`)

Around line 92-110 of `open-sse/translator/index.js`:

```js
const directRouteDisabled = process.env.DISABLE_DIRECT_TRANSLATION_ROUTES === "1";

// If same format, skip translation steps
if (sourceFormat !== targetFormat) {
  // Direct route: if a translator is registered for this exact source:target
  // pair, use it instead of pivoting through OpenAI...
  const directFn = !directRouteDisabled
    ? requestRegistry.get(`${sourceFormat}:${targetFormat}`)
    : null;
  if (directFn) {
    result = directFn(model, result, stream, credentials);
  } else {
    // ... existing pivot fallback
  }
}
```

### Response side (`translateResponse`)

Around line 167-176:

```js
const directRouteDisabled = process.env.DISABLE_DIRECT_TRANSLATION_ROUTES === "1";
const directFn = !directRouteDisabled
  ? responseRegistry.get(`${targetFormat}:${sourceFormat}`)
  : null;
if (directFn) {
  const converted = directFn(chunk, state);
  return converted ? (Array.isArray(converted) ? converted : [converted]) : [];
}
```

### Optional — per-pair flags

If broader granularity is desired (e.g., disable only `kiro:claude` while keeping a future `gemini:claude` direct), parse `DISABLE_DIRECT_TRANSLATION_ROUTES` as a comma-separated list of `source:target` pairs:

```js
const disabled = (process.env.DISABLE_DIRECT_TRANSLATION_ROUTES || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const isDisabled = (key) => disabled.includes("*") || disabled.includes(key);
```

For a first pass, the boolean form is fine. Document in `9router-development/DEVELOPMENT.md` (or wherever env vars are listed).

## Don't add

- Don't put this behind a database-driven setting yet — env var is the right granularity for an emergency rollback.
- Don't make the default disabled — that defeats the PR.
- Don't add a UI toggle in the dashboard — overkill for a safety hatch.

## Acceptance criteria

- With `DISABLE_DIRECT_TRANSLATION_ROUTES=1`, a Claude→Kiro request flows through the pivot path. Verify by checking the request shape, or by adding a temporary `console.log` in both translators and observing which one fires.
- With the env var unset (default), behavior is identical to current PR #1737.
- A new test asserts both branches: stub `process.env.DISABLE_DIRECT_TRANSLATION_ROUTES` and verify the same `translateRequest` call produces the OpenAI-pivot intermediate when disabled and skips it when enabled.
- Document the env var in `9router-development/DEVELOPMENT.md` under a clearly-marked "rollback flags" section.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
DISABLE_DIRECT_TRANSLATION_ROUTES=1 pnpm vitest run tests/translator/
```

In production, this flag becomes a docker-compose env entry on the relevant service. (Don't add it there as part of this task — leave it for the operator to opt in.)

## Why this matters

The direct route is novel code on a hot path. Even with all the fixes from tasks 01-03, you want a single-keystroke way to revert to the proven pivot if a customer reports something weird. Code rollback takes minutes; an env flag flip plus restart takes seconds.

## Reference

- Translator dispatch: `open-sse/translator/index.js:75-194`.
- Tasks already loading env config: search the codebase for `process.env.` patterns under `open-sse/config/`.
