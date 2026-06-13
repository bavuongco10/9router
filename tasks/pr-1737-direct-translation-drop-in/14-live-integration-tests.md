# Task 14 — Real-server integration tests against the dev instance

**Priority:** P1 (recommended before merging the 01–13 work)
**Depends on:** Task 04 (rollback flag) lands first — needed for the pivot-vs-direct A/B. If 04 isn't ready, run with the live route only and skip §3.4.
**Files:** new `tests/integration/claude-kiro-direct.live.test.js`; updates to `package.json` test scripts.

## Goal

Vitest unit tests in tasks 01-08 prove the *translator* logic. They don't prove the **route** works end-to-end against real Kiro. This task adds a small live integration suite that:

1. Hits the dev `9router-development` instance over HTTP at `/v1/messages` with Anthropic Messages API shape, against a Kiro-routed model.
2. Asserts the response is a well-formed Claude SSE stream (or non-streaming Claude message).
3. Exercises the four behaviors most likely to regress on the direct route: text streaming, tool use round-trip, the two 400-guards from PR #1737, and (optional) `system` prompt placement parity vs the pivot.

The suite is **opt-in**: it only runs when `TEST_9ROUTER_API_KEY` and `TEST_9ROUTER_URL` are set, so CI / local unit runs never burn Kiro quota.

## Setup

### 1. Credentials — never commit

The 9router API key is a secret. Do not put it in `package.json`, in this task file, or anywhere git tracks. Set it in the shell that runs the tests:

```bash
export TEST_9ROUTER_API_KEY="sk-XXXX-XXXXX-XXXXXXXX"   # paste the literal key here
export TEST_9ROUTER_URL="http://localhost:3000"        # or whatever the dev instance binds to
export TEST_9ROUTER_MODEL="claude-sonnet-4.5"          # an alias your account routes to Kiro — confirm via dashboard
```

If you store it in `.env.test.local`, make sure `.env.test.local` is in `.gitignore` first. Don't commit that file even if gitignored — `git diff --staged | grep -i sk-` before any commit involving this work.

### 2. Start the dev server

From the repo root:

```bash
./run-development.sh
```

This runs `next dev` on port 3000 with `data-development/` as the data dir (see the script for what env it loads). Wait for `Ready in Xs` in the log before running the suite.

Verify the route is live:

```bash
curl -sS -X POST "$TEST_9ROUTER_URL/v1/messages" \
  -H "x-api-key: $TEST_9ROUTER_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"'"$TEST_9ROUTER_MODEL"'","max_tokens":32,"messages":[{"role":"user","content":"reply with the word OK"}]}' \
  | head -c 500
```

You should see Anthropic-format JSON (id, type:"message", content, etc.) — not an HTML error page. If it 401s, your key is wrong or unbound to the workspace; if it 404s, the rewrite from `/v1/messages` → `/api/v1/messages` isn't taking effect; if it 500s, check `9router-development` logs.

### 3. Confirm the model routes to Kiro

The test only verifies the **direct claude:kiro path** if the model you pick is actually configured to route to Kiro. Open the dashboard at `$TEST_9ROUTER_URL/dashboard/endpoint`, find the alias / combo `$TEST_9ROUTER_MODEL` resolves to, and confirm the provider is Kiro (i.e., AWS CodeWhisperer). If it routes elsewhere, change `$TEST_9ROUTER_MODEL` until it does.

## The test file

New file at `9router-development/tests/integration/claude-kiro-direct.live.test.js`:

```js
import { describe, it, expect, beforeAll } from "vitest";

const URL = process.env.TEST_9ROUTER_URL;
const KEY = process.env.TEST_9ROUTER_API_KEY;
const MODEL = process.env.TEST_9ROUTER_MODEL || "claude-sonnet-4.5";

const skip = !URL || !KEY;
const d = skip ? describe.skip : describe;

const post = (body, { stream = false } = {}) =>
  fetch(`${URL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(stream ? { accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({ model: MODEL, ...body, ...(stream ? { stream: true } : {}) }),
  });

async function readSSEEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame.split("\n").find(l => l.startsWith("data:"));
      if (!data) continue;
      const json = data.slice(5).trim();
      if (json === "[DONE]") return events;
      try { events.push(JSON.parse(json)); } catch { /* keepalive comment */ }
    }
  }
  return events;
}

d("9router /v1/messages — Claude → Kiro direct route (live)", () => {
  beforeAll(() => {
    if (skip) console.warn("Skipping live tests — set TEST_9ROUTER_URL + TEST_9ROUTER_API_KEY");
  });

  it("non-streaming text request returns a Claude message", async () => {
    const res = await post({ max_tokens: 64, messages: [{ role: "user", content: "Reply with just the word OK" }] });
    expect(res.status, await res.text().catch(() => "")).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content.find(b => b.type === "text")?.text).toMatch(/OK/i);
    expect(["end_turn", "stop_sequence"]).toContain(body.stop_reason);
  }, 60_000);

  it("streaming text request emits a well-formed Claude SSE sequence", async () => {
    const res = await post(
      { max_tokens: 64, messages: [{ role: "user", content: "Count from 1 to 3, one number per line" }] },
      { stream: true }
    );
    expect(res.status).toBe(200);
    const events = await readSSEEvents(res);
    const types = events.map(e => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types[types.length - 1]).toBe("message_stop");
    const md = events.find(e => e.type === "message_delta");
    expect(md.delta.stop_reason).toBeTruthy();
    expect(md.usage).toBeDefined();
  }, 90_000);

  it("guard 1: client omits `tools` on a turn carrying a stale tool_result — no 400", async () => {
    // Reproduces the 400 trap PR #1737's flattenClaudeToolInteractions guards.
    const res = await post({
      max_tokens: 32,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] },
        { role: "user", content: "say OK and stop" },
      ],
    });
    expect(res.status, await res.text().catch(() => "")).not.toBe(400);
    expect(res.status).toBe(200);
  }, 60_000);

  it("guard 2: tool_result with an orphaned tool_use_id — no 400", async () => {
    const res = await post({
      max_tokens: 32,
      tools: [{ name: "f", description: "fn", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "salvage me" }] },
        { role: "user", content: "say OK and stop" },
      ],
    });
    expect(res.status, await res.text().catch(() => "")).not.toBe(400);
    expect(res.status).toBe(200);
  }, 60_000);

  it("tool round-trip: model chooses a tool, we return a result, model finishes", async () => {
    const tools = [{
      name: "get_weather",
      description: "Get the current weather in a city.",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }];

    const r1 = await post({
      max_tokens: 256,
      tools,
      messages: [{ role: "user", content: "What's the weather in Paris? Use the tool." }],
    });
    expect(r1.status).toBe(200);
    const m1 = await r1.json();
    const toolUse = m1.content.find(b => b.type === "tool_use");
    expect(toolUse, "model did not call the tool — try a more directive prompt or a different model").toBeTruthy();
    expect(toolUse.name).toBe("get_weather");
    expect(typeof toolUse.input).toBe("object");

    const r2 = await post({
      max_tokens: 128,
      tools,
      messages: [
        { role: "user", content: "What's the weather in Paris? Use the tool." },
        { role: "assistant", content: m1.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "Sunny, 18°C" }] },
      ],
    });
    expect(r2.status).toBe(200);
    const m2 = await r2.json();
    const text = m2.content.find(b => b.type === "text")?.text || "";
    expect(text).toMatch(/sunny|18|paris/i);
    expect(["end_turn", "tool_use"]).toContain(m2.stop_reason);
  }, 120_000);
});
```

### Run it

```bash
cd 9router-development
pnpm vitest run tests/integration/claude-kiro-direct.live.test.js
```

Add to `package.json` if it makes the `pnpm` flow easier:

```json
{
  "scripts": {
    "test:live": "vitest run tests/integration/"
  }
}
```

## §3.4 (optional) — pivot vs direct A/B parity

Once task 04's rollback flag is in, add an A/B test that runs the same prompt twice — once with the direct route, once forced to pivot — and asserts the responses agree on shape (token count within ±10%, stop_reason matches, tool calls match if any). This is the strongest single test of "drop-in":

```js
import { describe, it, expect } from "vitest";

const URL = process.env.TEST_9ROUTER_URL;
const KEY = process.env.TEST_9ROUTER_API_KEY;
const MODEL = process.env.TEST_9ROUTER_MODEL || "claude-sonnet-4.5";

// Run two requests against the SAME server but with different env-var presence
// requires task 04 — DISABLE_DIRECT_TRANSLATION_ROUTES toggles per-request via header,
// or restart the dev server between runs (see task 04 for which approach you chose).

// If your task 04 implementation is request-header-based (recommended for testing):
const post = (forceDirect) => fetch(`${URL}/v1/messages`, {
  method: "POST",
  headers: {
    "x-api-key": KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    ...(forceDirect ? {} : { "x-9router-disable-direct-route": "1" }),
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: "Briefly explain prompt caching" }],
    temperature: 0,
  }),
});

it("direct route and pivot route produce equivalent responses", async () => {
  const [direct, pivot] = await Promise.all([post(true), post(false)]);
  expect(direct.status).toBe(200);
  expect(pivot.status).toBe(200);
  const d = await direct.json(), p = await pivot.json();
  expect(d.stop_reason).toBe(p.stop_reason);
  // Tokens won't match exactly (sampling), but shape should
  expect(Math.abs(d.usage.output_tokens - p.usage.output_tokens) / p.usage.output_tokens).toBeLessThan(0.5);
}, 120_000);
```

If task 04 chose the env-var approach (server restart needed to flip), skip this A/B until you can header-toggle, OR run the suite twice manually (once with the env var unset, once with `=1`) and diff the JSON outputs.

## Anti-patterns (do not do)

- ❌ Don't hardcode the API key in the test file or `package.json`.
- ❌ Don't run live tests on every `pnpm test` — they cost real Kiro quota and break in CI without secrets. Keep them in `tests/integration/` and gate via env vars.
- ❌ Don't assert exact response text (model output is non-deterministic). Assert shape, types, and presence of expected substrings or block types.
- ❌ Don't write the user-supplied key into commit messages, debug logs, or task files. If a test debug dumps the key in a 401 response, scrub it.

## Acceptance criteria

- All five required tests in §3.1-§3.5 pass against the dev instance.
- Tests skip cleanly (no failure) when `TEST_9ROUTER_API_KEY` is unset.
- `pnpm test` (the unit suite) is unaffected — live tests live in `tests/integration/` and are not picked up by the default vitest pattern unless explicitly run.
- The test file does not contain a literal API key, URL, or any other secret.
- §3.4 A/B test passes once task 04 ships, OR is documented as "to be enabled when 04 lands."

## How to verify

```bash
cd 9router-development
# unit tests still green:
pnpm vitest run tests/translator/

# live tests, run with credentials:
TEST_9ROUTER_URL="http://localhost:3000" \
TEST_9ROUTER_API_KEY="sk-..." \
TEST_9ROUTER_MODEL="claude-sonnet-4.5" \
pnpm vitest run tests/integration/

# live tests skip cleanly without credentials:
pnpm vitest run tests/integration/   # → all "skipped" or "no tests"
```

## Why this matters

Unit tests verify the translator logic; live tests verify the **whole stack** — the Next.js rewrite, the auth check, the provider routing, the Kiro executor, and the new direct translator together. PR #1737 changes the dispatch logic in `index.js`; a unit test that mocks the registry won't catch a real bug in the dispatch arm. The five live tests above add ~3 minutes of runtime but cover every behavior the user-facing workflow depends on.

## References

- Dev startup: `run-development.sh` at the repo root (Node 22 via nvm, `next dev`, port 3000, data dir `./data-development`).
- Endpoint route: `9router-development/src/app/api/v1/messages/route.js` (calls `handleChat`, which dispatches via `translateRequest`).
- Next.js rewrite: `9router-development/next.config.mjs` — `/v1/messages` → `/api/v1/messages`.
- Direct translator dispatch: `open-sse/translator/index.js:75-194` (the new direct-route branch added in PR #1737).
- Anthropic Messages API request/response shape: `shared/tool-use-concepts.md` and `typescript/claude-api/README.md` in the claude-api skill.
