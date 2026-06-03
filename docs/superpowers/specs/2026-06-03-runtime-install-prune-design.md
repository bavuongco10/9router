# Design: Runtime Installs Preserve Existing Dependencies

## Problem

9router lazily installs native/runtime dependencies into a user-writable runtime directory:

- `better-sqlite3@12.6.2` from `cli/hooks/sqliteRuntime.js`
- `systray2@2.1.4` from `cli/hooks/trayRuntime.js`

Both installs target the same runtime project directory: `getRuntimeDir()` (`DATA_DIR/runtime`, or the platform default under the user's data directory). `postinstall.js` runs them in sequence: SQLite first, tray second.

The SQLite install currently passes `optional: true`, which maps to `npm install --no-save`. The tray install hardcodes `npm install --no-save`. In a runtime project whose `package.json` does not list installed packages, the second `--no-save` install lets npm prune the first package as extraneous. This can leave `systray2` installed while `better-sqlite3` has been removed, causing 9router to report "No SQLite driver available" even after the SQLite runtime install appeared to succeed.

## Goal

Make lazy runtime installs coexist in the shared runtime directory. Installing or reinstalling `systray2` must not prune `better-sqlite3`, and installing or reinstalling `better-sqlite3` must not prune `systray2`.

## Solution

### Approach

Replace both `--no-save` installs with normal saved installs. npm will then record each runtime package in `package.json` under `dependencies`, so later installs treat earlier packages as expected project dependencies instead of extraneous packages.

While making that behavioral fix, extract runtime-directory helpers, npm install execution, npm error summarization, and package-specific install logging into `cli/hooks/runtimeInstall.js`. `sqliteRuntime.js` imports those helpers and re-exports the primitives that existing callers already import from `sqliteRuntime.js`. `trayRuntime.js` imports directly from `runtimeInstall.js` for the shared install helper. This avoids a CommonJS circular dependency.

### Runtime manifest

`ensureRuntimeDir()` continues to create a minimal runtime `package.json` when missing:

```json
{
  "name": "9router-runtime",
  "version": "1.0.0",
  "private": true,
  "description": "User-writable runtime deps for 9router (better-sqlite3 native binary)"
}
```

The design does not require pre-populating `dependencies: {}`. npm creates or updates the `dependencies` field when `npm install <pkg>` runs without `--no-save`.

### Shared helper

Create `cli/hooks/runtimeInstall.js` with these responsibilities:

1. `getDataDir()`, `getRuntimeDir()`, and `getRuntimeNodeModules()` define the shared user-writable runtime location.
2. `ensureRuntimeDir()` creates the shared runtime project directory and minimal `package.json`.
3. `summarizeNpmError(stderr)` keeps the existing short, user-friendly npm failure summaries.
4. `runNpmInstall({ cwd, pkgs, extraArgs, timeout })` keeps the existing npm invocation wrapper.
5. `installRuntimePackages(pkgs, options)` runs `runNpmInstall()` without `--no-save`, logs package-specific failure guidance, and returns a boolean success result.

`sqliteRuntime.js` will import and re-export `getRuntimeDir()`, `getRuntimeNodeModules()`, `runNpmInstall()`, and `summarizeNpmError()` so existing imports from `sqliteRuntime.js` keep working.

### Install options

`installRuntimePackages(pkgs, options)` accepts:

| Option | Type | Default | Purpose |
| --- | --- | --- | --- |
| `silent` | boolean | `false` | Suppress progress and warning logs when true |
| `timeout` | number | `180000` | Timeout passed through to `runNpmInstall()` |
| `label` | string | `"runtime package"` | Human-readable install label for progress logs |
| `failureTitle` | string | `"Runtime package install failed"` | Package-specific warning title |
| `failureHint` | string | `"runtime dependency unavailable"` | Package-specific warning hint |

It deliberately does **not** accept the old `optional` flag. That flag only existed to trigger `--no-save`; after this fix it is dead API surface.

### File Changes

#### 1. `cli/hooks/runtimeInstall.js` (new)

Add the shared helper:

```js
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function getDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  return process.platform === "win32"
    ? path.join(process.env.APPDATA || os.homedir(), "9router")
    : path.join(os.homedir(), ".9router");
}

function getRuntimeDir() {
  return path.join(getDataDir(), "runtime");
}

function getRuntimeNodeModules() {
  return path.join(getRuntimeDir(), "node_modules");
}

function ensureRuntimeDir() {
  const dir = getRuntimeDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
      name: "9router-runtime",
      version: "1.0.0",
      private: true,
      description: "User-writable runtime deps for 9router (better-sqlite3 native binary)",
    }, null, 2));
  }

  return dir;
}

function summarizeNpmError(stderr = "") {
  const text = String(stderr);
  if (/ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|getaddrinfo/i.test(text)) return "No internet connection or registry unreachable";
  if (/EACCES|EPERM|permission denied/i.test(text)) return "Permission denied (check folder permissions)";
  if (/ENOSPC|no space/i.test(text)) return "Not enough disk space";
  if (/node-gyp|gyp ERR|python|MSBuild|Visual Studio|Xcode/i.test(text)) return "Missing build tools (Xcode CLT / Python / VS Build Tools)";
  if (/ETARGET|version.*not found/i.test(text)) return "Package version not found on registry";
  const m = text.match(/npm ERR! (.+)/);
  if (m) return m[1].slice(0, 200);
  const lastLine = text.trim().split(/\r?\n/).filter(Boolean).pop();
  return lastLine ? lastLine.slice(0, 200) : "Unknown error";
}

function runNpmInstall({ cwd, pkgs, extraArgs = [], timeout = 180000 }) {
  const args = ["install", ...pkgs, "--no-audit", "--no-fund", "--prefer-online", ...extraArgs];
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npmCmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  return { ok: res.status === 0, code: res.status, stderr: res.stderr || "", stdout: res.stdout || "" };
}

function installRuntimePackages(pkgs, {
  silent = false,
  timeout = 180000,
  label = "runtime package",
  failureTitle = "Runtime package install failed",
  failureHint = "runtime dependency unavailable",
} = {}) {
  const cwd = ensureRuntimeDir();
  if (!silent) console.log(`⏳ Installing ${label} (first run)...`);

  const res = runNpmInstall({ cwd, pkgs, timeout });
  if (!res.ok && !silent) {
    const reason = summarizeNpmError(res.stderr);
    console.warn(`⚠️  ${failureTitle}`);
    console.warn(`   Reason: ${reason}`);
    console.warn(`   Retry:  cd "${cwd}" && npm install ${pkgs.join(" ")}`);
    console.warn(`   Result: ${failureHint}`);
  }

  return res.ok;
}

module.exports = {
  ensureRuntimeDir,
  getRuntimeDir,
  getRuntimeNodeModules,
  installRuntimePackages,
  runNpmInstall,
  summarizeNpmError,
};
```

No `extraArgs` are passed by `installRuntimePackages()`. This is the behavior change that prevents pruning. `runNpmInstall()` keeps `extraArgs` for backwards-compatible utility behavior, but the runtime callers no longer pass `--no-save`.

#### 2. `cli/hooks/sqliteRuntime.js`

Remove the local `getDataDir()`, `getRuntimeDir()`, `getRuntimeNodeModules()`, `ensureRuntimeDir()`, `summarizeNpmError()`, `runNpmInstall()`, and `npmInstall()` implementations.

Replace the current imports with:

```js
const fs = require("fs");
const path = require("path");
const {
  ensureRuntimeDir,
  getRuntimeDir,
  getRuntimeNodeModules,
  installRuntimePackages,
  runNpmInstall,
  summarizeNpmError,
} = require("./runtimeInstall");
```

Update the install call inside `ensureSqliteRuntime()`:

```js
const ok = installRuntimePackages([`better-sqlite3@${BETTER_SQLITE3_VERSION}`], {
  silent,
  label: "SQLite engine",
  failureTitle: "SQLite engine install failed — using fallback",
  failureHint: "using fallback",
});
```

Keep the public exports unchanged:

```js
module.exports = {
  ensureSqliteRuntime,
  buildEnvWithRuntime,
  getRuntimeDir,
  getRuntimeNodeModules,
  runNpmInstall,
  summarizeNpmError,
};
```

#### 3. `cli/hooks/trayRuntime.js`

Remove the local `ensureRuntimeDir()` and `npmInstall()` implementations. Replace its current import from `sqliteRuntime.js` with a direct shared-helper import:

```js
const {
  getRuntimeDir,
  getRuntimeNodeModules,
  installRuntimePackages,
} = require("./runtimeInstall");
```

Update the install call inside `ensureTrayRuntime()`:

```js
const ok = installRuntimePackages([`${SYSTRAY_PKG}@${SYSTRAY_VERSION}`], {
  silent,
  timeout: 120000,
  label: "system tray",
  failureTitle: "System tray install failed — tray disabled",
  failureHint: "tray disabled",
});
```

The public export stays unchanged:

```js
module.exports = { ensureTrayRuntime };
```

#### 4. `tests/unit/runtimeInstall.test.js` (new)

Add Vitest coverage for the helper. The tests should avoid real npm installs by prepending a fake npm executable to `PATH` and using a temporary `DATA_DIR`.

The fake npm executable captures its working directory and argv into a JSON file, then exits with the code configured by the test. This verifies the real `runNpmInstall()` wrapper without contacting the network.

Key cases:

1. `ensureRuntimeDir()` creates the runtime dir and minimal manifest.
2. `installRuntimePackages()` invokes npm without `--no-save`.
3. `installRuntimePackages()` forwards package-specific timeout and returns false on install failure.
4. `sqliteRuntime.js` still re-exports runtime primitives for existing callers.

The important regression assertion is that captured npm argv does not include `--no-save`.

## Out of Scope

- Running real `npm install better-sqlite3` or `npm install systray2` in unit tests
- Changing package versions (`better-sqlite3@12.6.2`, `systray2@2.1.4` stay as-is)
- Changing where the runtime directory lives
- Changing SQLite fallback behavior when native install fails
- Changing tray behavior on Windows
- Adding a postinstall self-test that loads both modules after install

## Backward Compatibility

- `ensureSqliteRuntime()` keeps the same public signature and return shape.
- `ensureTrayRuntime()` keeps the same public signature and return shape.
- `getRuntimeDir()`, `getRuntimeNodeModules()`, `runNpmInstall()`, and `summarizeNpmError()` stay exported from `sqliteRuntime.js` for existing imports.
- `runNpmInstall()` keeps the same signature, including `extraArgs`, for any existing direct caller.
- Existing runtime directories with package.json files continue to work. The next saved install updates the manifest with the installed runtime dependency.
- Existing runtime directories whose `better-sqlite3` was pruned will recover on the next `ensureSqliteRuntime()` call because it detects the missing module and reinstalls it.

## Testing Strategy

- **Unit tests** (`tests/unit/runtimeInstall.test.js`): verify runtime package.json creation, saved install invocation without `--no-save`, package-specific timeout forwarding, failure logging, and `sqliteRuntime.js` re-exports.
- **Targeted existing behavior check**: run the new unit test plus existing SQLite/database runtime-adjacent tests.
- **No E2E**: change is local to runtime install orchestration and npm invocation arguments. Real package installation is intentionally not exercised in unit tests because it is slow, network-dependent, and platform-sensitive.

## Open Questions

None. The chosen scope is the pragmatic fix: remove the prune-causing install flag and deduplicate the shared install wrapper, without adding a broader self-test.
