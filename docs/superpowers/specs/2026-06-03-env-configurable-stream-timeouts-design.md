# Design: Env-configurable Stream & Fetch Timeouts

## Problem

9router hardcodes two timeouts in `open-sse/config/runtimeConfig.js`:

- `STREAM_STALL_TIMEOUT_MS = 30 * 1000` — aborts the stream if no chunk arrives within 30s
- `FETCH_CONNECT_TIMEOUT_MS = 20 * 1000` — aborts the upstream fetch if headers don't arrive within 20s

Recent releases have made this worse for slow / deep-reasoning models:

- v0.4.63 (2026-05-26): lowered 60s → 35s
- v0.4.66 (2026-05-29): lowered 35s → 30s

Operators running models with long reasoning phases (Xiaomi mimo-v2.5, zai/glm-5.1, Claude thinking via Kiro, etc.) hit "stream stall timeout" mid-generation. See upstream issues:

- #1621 — "[Bug] Frequent 'stream stall timeout' when proxying Claude Code CLI requests to Xiaomi mimo-v2.5 via 9router" (2 comments, detailed root-cause analysis)
- #1557 — "Make STREAM_STALL_TIMEOUT_MS and FETCH_CONNECT_TIMEOUT_MS configurable via Env Vars" (2 comments)

The analysis in #1621 documents four contributing factors. This design only addresses the **config knob** part — making the timeouts user-tunable so each operator can pick values that match their upstream. The other three factors (keep-alive headers, per-route timeout, smarter logging) are explicitly out of scope for this PR.

## Goal

Make `STREAM_STALL_TIMEOUT_MS` and `FETCH_CONNECT_TIMEOUT_MS` overridable at runtime via environment variables, without breaking any existing import, default, or behavior. Operators with slow upstreams can now set a higher timeout; everyone else gets the same 30s / 20s defaults as today.

## Solution

### Approach

Replace the literal constant value with a value computed once at module load from `process.env`. The exported identifier and type stay identical, so every consumer (currently `open-sse/utils/streamHandler.js`) keeps working unchanged.

A small internal helper `_parseTimeoutMs(envName, defaultMs)` does the env read, validation, and fallback. Reading happens **once** when the module is first imported — not per request, not lazy.

### Env var naming

`NINE_ROUTER_` prefix on both vars to avoid clashing with unrelated system env:

- `NINE_ROUTER_STREAM_STALL_TIMEOUT_MS` → maps to `STREAM_STALL_TIMEOUT_MS`
- `NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS` → maps to `FETCH_CONNECT_TIMEOUT_MS`

Values are **positive integers in milliseconds** (e.g. `60000` for 60 seconds). No unit suffixes in v1 — keep the parser simple.

### Validation

| Input | Result |
| --- | --- |
| not set / empty | use default, no log |
| valid positive integer (`"60000"`) | use parsed value |
| `60000` with surrounding whitespace (`"  60000  "`) | use parsed value (trim before check) |
| non-numeric (`"30s"`, `"abc"`) | warn, fall back to default |
| `0` or negative | warn, fall back to default |
| float with non-integer characters (`"60.5"`) | warn, fall back to default |

The warning is a single `console.warn` at module load. The service does **not** throw — a misconfigured env must not prevent the service from starting. If a user genuinely wants to disable the timeout, they can set it to a very large value (e.g. `Number.MAX_SAFE_INTEGER`).

### File Changes

#### 1. `open-sse/config/runtimeConfig.js`

Add helper near the top (after the leading comment block, before `HTTP_STATUS`):

```js
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

Replace the two existing constant declarations:

```js
// Stream stall timeout: abort if no chunk received within this duration.
// Override via env var NINE_ROUTER_STREAM_STALL_TIMEOUT_MS (milliseconds).
const _stallTimeoutMs = _parseTimeoutMs(
  "NINE_ROUTER_STREAM_STALL_TIMEOUT_MS",
  30 * 1000
);
export const STREAM_STALL_TIMEOUT_MS = _stallTimeoutMs;

// Fetch connect timeout: abort if upstream doesn't return response headers
// within this duration. Override via env var NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS
// (milliseconds).
const _fetchConnectTimeoutMs = _parseTimeoutMs(
  "NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS",
  20 * 1000
);
export const FETCH_CONNECT_TIMEOUT_MS = _fetchConnectTimeoutMs;
```

The named exports keep the same names, same `number` type, same default values.

#### 2. `tests/unit/runtimeConfig.test.js` (new)

Vitest tests covering all the validation cases above. Use `vi.stubEnv` and `vi.resetModules()` + dynamic `await import(...)` so each test gets a fresh module load with its own env. Capture `console.warn` via `vi.spyOn(console, 'warn')` for the invalid-input cases. Follow the existing test style in `tests/unit/minimax-usage.test.js`.

#### 3. `.env.example`

Add a new section between the current "Recommended runtime variables" and "Recommended security and ops variables" blocks:

```bash
# Stream & fetch timeouts (milliseconds). Override to accommodate slow
# upstreams or deep-reasoning models. Both default to safe values that
# match the original hardcoded constants; raise them only if you see
# "stream stall timeout" errors in the logs.
# NINE_ROUTER_STREAM_STALL_TIMEOUT_MS=30000
# NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS=20000
```

#### 4. `README.md`

Add two rows to the Environment Variables table (around line 1095):

```
| `NINE_ROUTER_STREAM_STALL_TIMEOUT_MS` | `30000` | Stream stall abort timeout in ms. Raise for slow reasoning models. |
| `NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS` | `20000` | Upstream fetch connect timeout in ms. Raise if you see connect timeouts to specific providers. |
```

#### 5. `CHANGELOG.md`

Add one bullet under the next (or "Unreleased") version, in the Features or Improvements section:

```
- Make `STREAM_STALL_TIMEOUT_MS` and `FETCH_CONNECT_TIMEOUT_MS` configurable via `NINE_ROUTER_STREAM_STALL_TIMEOUT_MS` and `NINE_ROUTER_FETCH_CONNECT_TIMEOUT_MS` env vars. Backward compatible — defaults unchanged.
```

## Out of Scope

- Raising the default timeout values
- Per-provider timeout overrides (e.g. Xiaomi automatically gets 5 minutes)
- Adding `Connection: keep-alive` / `X-Accel-Buffering: no` headers to upstream requests
- Retry-on-stall logic (e.g. fallback to another provider)
- More granular logging fields
- Hot-reload of env var without restart

These are all valid follow-ups but each is its own design discussion. This PR is intentionally minimal: one file of runtime code, one test file, two doc edits.

## Backward Compatibility

- Public named exports `STREAM_STALL_TIMEOUT_MS` and `FETCH_CONNECT_TIMEOUT_MS` keep the same names and `number` type.
- Default values are unchanged (30000 / 20000).
- No code outside `runtimeConfig.js` needs to change. `streamHandler.js` keeps its current import.
- No migration step. Existing deployments are unaffected unless they opt in by setting the env vars.

## Testing Strategy

- **Unit tests** (new `tests/unit/runtimeConfig.test.js`): cover default behavior, valid override, trim, and each invalid input class.
- **No new E2E** — change is local, no new request-path behavior. Existing E2E suite should continue to pass.
- **Manual verification** (optional, can be skipped for CI): set `NINE_ROUTER_STREAM_STALL_TIMEOUT_MS=120000`, start the service, hit a slow provider, confirm in logs that the new value is used (`pipe start | stallTimeout=120000ms`).

## Open Questions

None at this time. All design decisions captured above.
