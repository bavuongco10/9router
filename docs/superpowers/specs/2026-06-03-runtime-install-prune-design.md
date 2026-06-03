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

While making that behavioral fix, extract the duplicated runtime-directory and install-wrapper code into a small shared helper. The helper keeps install behavior consistent for both runtime dependencies without changing the public `ensureSqliteRuntime()` or `ensureTrayRuntime()` APIs used by `postinstall.js` and `cli.js`.

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

Create `cli/hooks/runtimeInstall.js` with two responsibilities:

1. `ensureRuntimeDir()` creates the shared runtime project directory and minimal `package.json`.
2. `installRuntimePackages(pkgs, options)` runs `runNpmInstall()` without `--no-save`, logs package-specific failure guidance, and returns a boolean success result.

The helper imports existing primitives from `sqliteRuntime.js`:

- `getRuntimeDir()`
- `runNpmInstall()`
- `summarizeNpmError()`

`sqliteRuntime.js` keeps exporting those primitives because existing code already imports them from there (`trayRuntime.js` and `cli/src/cli/tray/tray.js`). This avoids a broader module reshuffle.

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
const fs = require("fs");
const path = require("path");
const { getRuntimeDir, runNpmInstall, summarizeNpmError } = require("./sqliteRuntime");

function ensureRuntimeDir() {
  const dir = getRuntimeDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: "9router-runtime",
      version: "1.0.0",
      private: true,
      description: "User-writable runtime deps for 9router (better-sqlite3 native binary)",
    }, null, 2));
  }

  return dir;
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

module.exports = { ensureRuntimeDir, installRuntimePackages };
```

No `extraArgs` are passed. This is the behavior change that prevents pruning.

#### 2. `cli/hooks/sqliteRuntime.js`

Remove the local `ensureRuntimeDir()` and `npmInstall()` implementations. Import the shared helper near the other requires:

```js
const { ensureRuntimeDir, installRuntimePackages } = require("./runtimeInstall");
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

Remove the local `ensureRuntimeDir()` and `npmInstall()` implementations. Replace its current import from `sqliteRuntime.js` with two focused imports:

```js
const { getRuntimeDir, getRuntimeNodeModules } = require("./sqliteRuntime");
const { installRuntimePackages } = require("./runtimeInstall");
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

Add Vitest coverage for the helper. The test should avoid real npm installs by mocking `runNpmInstall()` and using a temporary `DATA_DIR`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const runNpmInstallMock = vi.fn();
const summarizeNpmErrorMock = vi.fn(() => "mock npm error");

vi.mock("../../cli/hooks/sqliteRuntime", () => ({
  getRuntimeDir: () => path.join(process.env.DATA_DIR, "runtime"),
  runNpmInstall: runNpmInstallMock,
  summarizeNpmError: summarizeNpmErrorMock,
}));

describe("runtimeInstall", () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-runtime-install-"));
    process.env.DATA_DIR = dataDir;
    runNpmInstallMock.mockReset();
    summarizeNpmErrorMock.mockClear();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("creates a minimal runtime package.json", async () => {
    const { ensureRuntimeDir } = await import("../../cli/hooks/runtimeInstall.js");

    const runtimeDir = ensureRuntimeDir();
    const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8"));

    expect(pkg).toMatchObject({
      name: "9router-runtime",
      version: "1.0.0",
      private: true,
    });
  });

  it("installs runtime packages without --no-save so npm records dependencies", async () => {
    runNpmInstallMock.mockReturnValue({ ok: true, stderr: "" });
    const { installRuntimePackages } = await import("../../cli/hooks/runtimeInstall.js");

    const ok = installRuntimePackages(["better-sqlite3@12.6.2"], { silent: true });

    expect(ok).toBe(true);
    expect(runNpmInstallMock).toHaveBeenCalledWith({
      cwd: path.join(dataDir, "runtime"),
      pkgs: ["better-sqlite3@12.6.2"],
      timeout: 180000,
    });
  });

  it("passes package-specific timeout and returns false on install failure", async () => {
    runNpmInstallMock.mockReturnValue({ ok: false, stderr: "npm ERR! nope" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { installRuntimePackages } = await import("../../cli/hooks/runtimeInstall.js");

    const ok = installRuntimePackages(["systray2@2.1.4"], {
      timeout: 120000,
      label: "system tray",
      failureTitle: "System tray install failed — tray disabled",
      failureHint: "tray disabled",
    });

    expect(ok).toBe(false);
    expect(runNpmInstallMock).toHaveBeenCalledWith({
      cwd: path.join(dataDir, "runtime"),
      pkgs: ["systray2@2.1.4"],
      timeout: 120000,
    });
    expect(warnSpy).toHaveBeenCalledWith("⚠️  System tray install failed — tray disabled");
  });
});
```

The important regression assertion is that `runNpmInstall()` receives no `extraArgs: ["--no-save"]`.

## Out of Scope

- Running real `npm install better-sqlite3` or `npm install systray2` in unit tests
- Changing package versions (`better-sqlite3@12.6.2`, `systray2@2.1.4` stay as-is)
- Changing where the runtime directory lives
- Changing SQLite fallback behavior when native install fails
- Changing tray behavior on Windows
- Migrating all runtime path helpers out of `sqliteRuntime.js`
- Adding a postinstall self-test that loads both modules after install

## Backward Compatibility

- `ensureSqliteRuntime()` keeps the same public signature and return shape.
- `ensureTrayRuntime()` keeps the same public signature and return shape.
- `getRuntimeDir()`, `getRuntimeNodeModules()`, `runNpmInstall()`, and `summarizeNpmError()` stay exported from `sqliteRuntime.js` for existing imports.
- Existing runtime directories with package.json files continue to work. The next saved install updates the manifest with the installed runtime dependency.
- Existing runtime directories whose `better-sqlite3` was pruned will recover on the next `ensureSqliteRuntime()` call because it detects the missing module and reinstalls it.

## Testing Strategy

- **Unit tests** (`tests/unit/runtimeInstall.test.js`): verify runtime package.json creation, saved install invocation without `--no-save`, package-specific timeout forwarding, and failure logging.
- **Targeted existing behavior check**: run existing SQLite/tray runtime tests if any exist. If no dedicated tests exist, run the new unit test plus the nearest runtime/config test group.
- **No E2E**: change is local to runtime install orchestration and npm invocation arguments. Real package installation is intentionally not exercised in unit tests because it is slow, network-dependent, and platform-sensitive.

## Open Questions

None. The chosen scope is the pragmatic fix: remove the prune-causing install flag and deduplicate the shared install wrapper, without adding a broader self-test or moving all runtime helpers.
