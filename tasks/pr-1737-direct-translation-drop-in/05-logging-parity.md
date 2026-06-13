# Task 05 — Logging parity: don't go dark on the direct route

**Priority:** P1 (recommended before merge)
**Files:** `9router-development/open-sse/translator/index.js`, possibly the dashboard route (`src/app/(dashboard)/dashboard/translator`).

## Problem

The pivot path attaches debug observability:

- **Request side** (`translateRequest`, line 99): `reqLogger?.logOpenAIRequest?.(result)` — the OpenAI intermediate gets recorded for the dashboard's translator panel.
- **Response side** (`translateResponse`, line 189-191): `results._openaiIntermediate = openaiResults` — the OpenAI-shaped intermediate stream is stashed alongside the final results so the dashboard can show "what we sent and what we received".

The new direct route bypasses both. A request that uses `claude:kiro` direct produces no `logOpenAIRequest` call and no `_openaiIntermediate` annotation, so the dashboard goes dark for that request. If the team is using the dashboard to debug 400s, that's a meaningful gap.

## Fix — choose one

### Option A — Synthesize a "direct route" log entry (cheapest)

Have the direct route fire a different logger hook, e.g. `reqLogger?.logDirectRouteRequest?.(sourceFormat, targetFormat, result)`. Update the dashboard to read the new key. The dashboard learns to display "(direct route — no OpenAI intermediate)" instead of an empty panel.

```js
// open-sse/translator/index.js, in translateRequest direct-route branch:
if (directFn) {
  result = directFn(model, result, stream, credentials);
  reqLogger?.logDirectRouteRequest?.(sourceFormat, targetFormat, result);
}
```

```js
// open-sse/translator/index.js, in translateResponse direct-route branch:
const converted = directFn(chunk, state);
const out = converted ? (Array.isArray(converted) ? converted : [converted]) : [];
out._directRoute = `${targetFormat}:${sourceFormat}`;
return out;
```

Then update the dashboard fetch logic in `src/app/(dashboard)/dashboard/translator/` to recognize either `_openaiIntermediate` (pivot) or `_directRoute` (direct) and render appropriately.

### Option B — Run the pivot logger as an aside (most expensive)

After the direct translator runs, also synthesize the OpenAI intermediate by running the existing claude→openai translator just for logging. Doubles the per-request CPU on the request path. Not recommended.

### Option C — Skip dashboard integration, log to stdout only

Add a debug log line. Not visible in the dashboard but at least leaves a trace. Worst of the three.

**Recommended: Option A.**

## Don't add

- Don't add a third "intermediate" format. The direct route's whole point is *no* intermediate.
- Don't log the full Claude request again — it's already captured upstream of `translateRequest`.

## Acceptance criteria

- A direct-route request produces a record in the dashboard's translator panel (or wherever pivot logs land). Empty intermediate is fine; the request itself must be visible.
- A direct-route response fires whichever hook the dashboard reads.
- The dashboard's translator UI shows direct-route requests in the same list as pivot requests, with a clear indicator that it took the direct path.
- A test stubs `reqLogger.logDirectRouteRequest` and verifies it's called with the expected args.
- Dashboard files updated: `src/app/(dashboard)/dashboard/translator/...` — find what currently consumes `_openaiIntermediate` and add the new branch.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
pnpm dev      # or pnpm next start
# In a browser, hit the dashboard's translator panel after firing a Claude→Kiro request.
```

## Why this matters

The whole reason 9router has a dashboard is to debug provider/format mismatches without redeploying. If the new fast-path is invisible to that dashboard, every direct-route bug becomes a "stare at logs" problem. Logging parity preserves the muscle memory the team has.

## Reference

- Pivot-side hooks: `open-sse/translator/index.js:99` and `:189-191`.
- Dashboard reader: `src/app/(dashboard)/dashboard/translator/` (find by grepping `_openaiIntermediate`).
