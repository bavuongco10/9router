# Env-configurable Stream & Fetch Timeouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `STREAM_STALL_TIMEOUT_MS` and `FETCH_CONNECT_TIMEOUT_MS` in `open-sse/config/runtimeConfig.js` overridable at runtime via `NINE_ROUTER_STREAM_STALL_TIMEOUT_MS` and `NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS` env vars, with backward-compatible defaults and a 100% test net for the new behavior.

**Architecture:** Add a private helper `_parseTimeoutMs(envName, defaultMs)` that reads `process.env` once at module load, validates strictly (positive integer in ms), warns and falls back on invalid input, and is silent on missing. The two existing `export const` declarations become thin wrappers around this helper. No other file imports change. Public named exports keep identical names and `number` type.

**Tech Stack:** JavaScript (ESM), Node 18+, vitest for unit tests. No new runtime dependencies.

---

## File Structure

Files touched by this plan, each with its responsibility:

| File | Responsibility | Change |
| --- | --- | --- |
| `open-sse/config/runtimeConfig.js` | Resolve `STREAM_STALL_TIMEOUT_MS` and `FETCH_CONNECT_TIMEOUT_MS` from env at module load; warn + fall back on invalid input | Modify — add helper, rewrite the two const declarations |
| `tests/unit/runtimeConfig.test.js` | Cover defaults, valid overrides, trim, invalid input, and warn behavior | Create |
| `.env.example` | Document supported env vars with safe defaults commented out | Modify — add one new section |
| `README.md` | Reference the new env vars in the Environment Variables table | Modify — add two table rows |
| `CHANGELOG.md` | Note the new configurability for the next release | Modify — add one bullet under the next version |

No new dependencies. No new files outside the ones above.

---

## Task 1: Write a failing test for env override behavior

**Files:**
- Create: `tests/unit/runtimeConfig.test.js`

- [ ] **Step 1: Create the test file with the env-override test**

Run: `mkdir -p tests/unit` (the directory already exists, this is a no-op safety net).

Write `tests/unit/runtimeConfig.test.js`:

```js
import { describe, it, expect, vi, afterEach } from "vitest";

const STALL_ENV = "NINE_ROUTER_STREAM_STALL_TIMEOUT_MS";
const FETCH_ENV = "NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS";

const importFresh = async () => {
  vi.resetModules();
  return import("../../open-sse/config/runtimeConfig.js");
};

describe("runtimeConfig env overrides", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the env value when NINE_ROUTER_STREAM_STALL_TIMEOUT_MS is set", async () => {
    vi.stubEnv(STALL_ENV, "60000");
    const mod = await importFresh();
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(60000);
  });
});
```

- [ ] **Step 2: Run the test and verify it FAILS**

Run: `cd tests && npm test -- runtimeConfig.test.js`

Expected: FAIL. The current `STREAM_STALL_TIMEOUT_MS` is the literal `30 * 1000` and ignores the env var, so the assertion `expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(60000)` will fail with something like `AssertionError: expected 30000 to be 60000`.

If the test PASSES, the helper is already implemented — stop, investigate, and confirm you are on the right base branch.

- [ ] **Step 3: Commit the failing test**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add tests/unit/runtimeConfig.test.js
git commit -m "test(runtimeConfig): add failing test for env override of stream stall timeout

Establishes the env-driven contract for STREAM_STALL_TIMEOUT_MS.
Fails on master because runtimeConfig.js still hardcodes the value.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Implement env-driven timeouts (make the test pass)

**Files:**
- Modify: `open-sse/config/runtimeConfig.js`

- [ ] **Step 1: Add the `_parseTimeoutMs` helper near the top of the file**

Open `open-sse/config/runtimeConfig.js`. The current top of the file (after the leading comment block) starts with `// HTTP status codes`. Insert the helper *above* that comment, immediately after any existing top-level comment:

```js
// Read a timeout (in milliseconds) from an env var, falling back to a default.
// Logs a warning and falls back if the value is not a positive integer.
// Reading happens once at module load — set the env var before importing.
function _parseTimeoutMs(envName, defaultMs) {
  const raw = process.env[envName];
  if (raw == null || raw === "") return defaultMs;
  const trimmed = raw.trim();
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    console.warn(
      `[runtimeConfig] Invalid ${envName}=${JSON.stringify(raw)}; using default ${defaultMs}ms. Expected positive integer in milliseconds.`
    );
    return defaultMs;
  }
  return parsed;
}
```

- [ ] **Step 2: Replace the two timeout constant declarations**

Find this block in `open-sse/config/runtimeConfig.js`:

```js
// Stream stall timeout: abort if no chunk received within this duration
export const STREAM_STALL_TIMEOUT_MS = 30 * 1000;

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = 20 * 1000;
```

Replace it with:

```js
// Stream stall timeout: abort if no chunk received within this duration.
// Override at runtime via env var NINE_ROUTER_STREAM_STALL_TIMEOUT_MS (milliseconds).
const _stallTimeoutMs = _parseTimeoutMs(
  "NINE_ROUTER_STREAM_STALL_TIMEOUT_MS",
  30 * 1000
);
export const STREAM_STALL_TIMEOUT_MS = _stallTimeoutMs;

// Fetch connect timeout: abort if upstream doesn't return response headers
// within this duration. Override at runtime via env var
// NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS (milliseconds).
const _fetchConnectTimeoutMs = _parseTimeoutMs(
  "NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS",
  20 * 1000
);
export const FETCH_CONNECT_TIMEOUT_MS = _fetchConnectTimeoutMs;
```

- [ ] **Step 3: Run the test and verify it PASSES**

Run: `cd tests && npm test -- runtimeConfig.test.js`

Expected: PASS. The single test "uses the env value when NINE_ROUTER_STREAM_STALL_TIMEOUT_MS is set" should now be green.

- [ ] **Step 4: Commit the implementation**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add open-sse/config/runtimeConfig.js
git commit -m "feat(runtimeConfig): make stream and fetch timeouts env-configurable

Add NINE_ROUTER_STREAM_STALL_TIMEOUT_MS and
NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS to override the hardcoded
constants at module load. Defaults and export names are unchanged,
so existing consumers and deployments are unaffected. Invalid
values warn once and fall back to defaults.

Addresses #1621 and #1557.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Add defensive tests for invalid input, trim, zero, negative, and defaults

**Files:**
- Modify: `tests/unit/runtimeConfig.test.js`

These tests guard the validation contract. The implementation from Task 2 already handles all of them, so most should pass immediately; if any fail, the impl in Task 2 was too permissive and we tighten it.

- [ ] **Step 1: Add the additional test cases**

Replace the contents of `tests/unit/runtimeConfig.test.js` with:

```js
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const STALL_ENV = "NINE_ROUTER_STREAM_STALL_TIMEOUT_MS";
const FETCH_ENV = "NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS";

const importFresh = async () => {
  vi.resetModules();
  return import("../../open-sse/config/runtimeConfig.js");
};

describe("runtimeConfig env overrides", () => {
  let warnSpy;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses the env value when NINE_ROUTER_STREAM_STALL_TIMEOUT_MS is set", async () => {
    vi.stubEnv(STALL_ENV, "60000");
    const mod = await importFresh();
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(60000);
  });

  it("uses the env value when NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS is set", async () => {
    vi.stubEnv(FETCH_ENV, "45000");
    const mod = await importFresh();
    expect(mod.FETCH_CONNECT_TIMEOUT_MS).toBe(45000);
  });

  it("falls back to 30000ms for stream stall when no env is set", async () => {
    const mod = await importFresh();
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(30000);
  });

  it("falls back to 20000ms for fetch connect when no env is set", async () => {
    const mod = await importFresh();
    expect(mod.FETCH_CONNECT_TIMEOUT_MS).toBe(20000);
  });

  it("trims surrounding whitespace from a valid env value", async () => {
    vi.stubEnv(STALL_ENV, "  90000  ");
    const mod = await importFresh();
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(90000);
  });

  it("warns and falls back when env value is non-numeric", async () => {
    vi.stubEnv(STALL_ENV, "30s");
    const mod = await importFresh();
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(30000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid ${STALL_ENV}="30s"`)
    );
  });

  it("warns and falls back when env value is zero", async () => {
    vi.stubEnv(FETCH_ENV, "0");
    const mod = await importFresh();
    expect(mod.FETCH_CONNECT_TIMEOUT_MS).toBe(20000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid ${FETCH_ENV}="0"`)
    );
  });

  it("warns and falls back when env value is negative", async () => {
    vi.stubEnv(STALL_ENV, "-5");
    const mod = await importFresh();
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(30000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid ${STALL_ENV}="-5"`)
    );
  });

  it("warns and falls back for partial-numeric values like '60abc'", async () => {
    vi.stubEnv(STALL_ENV, "60abc");
    const mod = await importFresh();
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(30000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid ${STALL_ENV}="60abc"`)
    );
  });

  it("does not warn when the env var is unset", async () => {
    const mod = await importFresh();
    expect(mod.STREAM_STALL_TIMEOUT_MS).toBe(30000);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test suite and verify everything passes**

Run: `cd tests && npm test -- runtimeConfig.test.js`

Expected: All 10 tests pass. The implementation from Task 2 already covers every case. If any test fails, the helper needs a tweak — the failure message will tell you which input class slipped through.

- [ ] **Step 3: Commit the expanded test suite**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add tests/unit/runtimeConfig.test.js
git commit -m "test(runtimeConfig): cover defaults, overrides, and invalid input

Adds the defensive test net for the new env-driven timeouts:
default values, valid overrides, whitespace trim, non-numeric,
zero, negative, and partial-numeric values. No production
change in this commit.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Document the new env vars (`.env.example`, `README.md`, `CHANGELOG.md`)

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a new section to `.env.example`**

Open `.env.example`. Between the current "Recommended runtime variables" block (lines 9–11) and the "Recommended security and ops variables" block (line 13), insert a new section:

```bash
# Stream & fetch timeouts (milliseconds). Override to accommodate slow
# upstreams or deep-reasoning models. Both default to safe values that
# match the original hardcoded constants; raise them only if you see
# "stream stall timeout" errors in the logs.
# NINE_ROUTER_STREAM_STALL_TIMEOUT_MS=30000
# NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS=20000
```

The final order of sections becomes: Required, Recommended runtime, **Stream & fetch timeouts (new)**, Recommended security and ops, Cloud sync, Outbound proxy, Unused.

- [ ] **Step 2: Add two rows to the Environment Variables table in `README.md`**

Open `README.md` and locate the Environment Variables table. It starts with `### Environment Variables` near line 1095. The last existing row is:

```
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | empty | Optional outbound proxy for upstream provider calls |
```

Add two new rows immediately after that one, keeping the alphabetical-ish order they're already in (the new rows are timeouts, place them just before the HTTP_PROXY row to keep proxy-related vars last):

```
| `NINE_ROUTER_STREAM_STALL_TIMEOUT_MS` | `30000` | Stream stall abort timeout in ms. Raise for slow reasoning models (Xiaomi mimo, zai/glm, etc.). |
| `NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS` | `20000` | Upstream fetch connect timeout in ms. Raise if specific providers hang on connect. |
```

(Inserting before the HTTP_PROXY row keeps the proxy block at the bottom; if you prefer to add at the end, that is also acceptable.)

- [ ] **Step 3: Add a `CHANGELOG.md` bullet for the next version**

Open `CHANGELOG.md`. The most recent version section is `v0.4.66 (2026-05-29)`. Add a new section at the very top of the version history (above `v0.4.66`) with the next version number if known — if not, use `## Unreleased`:

```markdown
## Unreleased

### Features
- Make `STREAM_STALL_TIMEOUT_MS` and `FETCH_CONNECT_TIMEOUT_MS` configurable via `NINE_ROUTER_STREAM_STALL_TIMEOUT_MS` and `NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS` environment variables. Backward compatible — defaults unchanged.
```

- [ ] **Step 4: Run a quick visual diff to confirm the doc edits are minimal and correct**

Run: `git diff .env.example README.md CHANGELOG.md`

Expected: Three small, focused hunks. The `.env.example` block is 4 lines. The `README.md` table gains 2 rows. The `CHANGELOG.md` gains one new top-level section. If anything else changed, undo and re-edit.

- [ ] **Step 5: Commit the doc updates**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add .env.example README.md CHANGELOG.md
git commit -m "docs: document NINE_ROUTER_* timeout env vars

Add the new env vars to .env.example, the README environment
variables table, and the CHANGELOG unreleased section. No code
or test changes.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Full regression check

**Files:** none — verification only.

- [ ] **Step 1: Run the full test suite and confirm no regressions**

Run: `cd tests && npm test`

Expected: All previously-passing tests still pass (including `embeddingsCore.test.js` and `minimax-usage.test.js`), and the new `runtimeConfig.test.js` is included. Total test count goes up by 10.

- [ ] **Step 2: Confirm the new exports are still importable from the original consumer**

Run from the repo root:

```bash
node --input-type=module -e "import { STREAM_STALL_TIMEOUT_MS, FETCH_CONNECT_TIMEOUT_MS } from './open-sse/config/runtimeConfig.js'; console.log(STREAM_STALL_TIMEOUT_MS, FETCH_CONNECT_TIMEOUT_MS);"
```

Expected output (with no env vars set): `30000 20000`.

- [ ] **Step 3: Confirm env override works end-to-end from the shell**

Run:

```bash
NINE_ROUTER_STREAM_STALL_TIMEOUT_MS=120000 NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS=60000 node --input-type=module -e "import { STREAM_STALL_TIMEOUT_MS, FETCH_CONNECT_TIMEOUT_MS } from './open-sse/config/runtimeConfig.js'; console.log(STREAM_STALL_TIMEOUT_MS, FETCH_CONNECT_TIMEOUT_MS);"
```

Expected output: `120000 60000`. This mirrors the typical deployment flow where the env is set in the process environment before the service starts.

- [ ] **Step 4: If anything failed in Steps 1–3, fix and commit; otherwise stop here**

There is no commit in this task — if you reach the end with everything green, you are done. If you needed a fix, create a new commit describing the fix and re-run from Step 1.

---

## Self-Review Checklist

- [x] **Spec coverage:** Every spec section maps to a task. Helper function in Task 2; unit tests in Tasks 1+3; `.env.example`, `README.md`, `CHANGELOG.md` in Task 4; regression check in Task 5.
- [x] **Placeholder scan:** No "TBD", "TODO", or "fill in details". Every code block is complete and runnable. Every commit command is a literal shell snippet.
- [x] **Type consistency:** The helper is named `_parseTimeoutMs` everywhere; the env names `NINE_ROUTER_STREAM_STALL_TIMEOUT_MS` and `NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS` are spelled the same in the spec, the plan, and the test file. The default values `30000` and `20000` match across spec, plan, and tests.
- [x] **TDD discipline:** Task 1 writes a failing test and commits it RED. Task 2 turns it GREEN. Task 3 adds the defensive net on top of a green implementation. Each commit is a logical unit.
- [x] **Frequent commits:** 5 commits total across 5 tasks — one per task. No mega-commits.
