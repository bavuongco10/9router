# Runtime Install Prune Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `better-sqlite3` from being pruned when the systray2 runtime install runs, by replacing both `--no-save` runtime installs with saved installs in a new shared `cli/hooks/runtimeInstall.js` helper, and migrating `sqliteRuntime.js` + `trayRuntime.js` to use it.

**Architecture:** Move all runtime primitives (`getDataDir`, `getRuntimeDir`, `getRuntimeNodeModules`, `ensureRuntimeDir`, `summarizeNpmError`, `runNpmInstall`, plus a new `installRuntimePackages` wrapper) into a new `cli/hooks/runtimeInstall.js`. `sqliteRuntime.js` imports them and re-exports the existing public surface (`getRuntimeDir`, `getRuntimeNodeModules`, `runNpmInstall`, `summarizeNpmError`). `trayRuntime.js` imports directly from `runtimeInstall.js`. The wrapper drops `--no-save`, so npm records each runtime package in `dependencies` and no longer prunes siblings.

**Tech Stack:** CommonJS (Node `require`) for the runtime hooks; Vitest (ESM) for the unit tests, with a fake `npm` on `PATH` to verify the real `runNpmInstall` wrapper. No new runtime dependencies.

---

## File Structure

Files touched by this plan:

| File | Responsibility | Change |
| --- | --- | --- |
| `cli/hooks/runtimeInstall.js` | Owns runtime primitives, npm install wrapper, package-specific install logging | Create |
| `cli/hooks/sqliteRuntime.js` | `ensureSqliteRuntime()` orchestrates SQLite install + fallback; re-exports primitives for existing imports | Modify — remove duplicate helpers, import from `runtimeInstall.js` |
| `cli/hooks/trayRuntime.js` | `ensureTrayRuntime()` orchestrates systray2 install + cleanup; uses shared install helper | Modify — remove duplicate helpers, import from `runtimeInstall.js` |
| `tests/unit/runtimeInstall.test.js` | Covers manifest creation, no-`--no-save` install via fake npm, failure logging, re-export of primitives | Create |
| `CHANGELOG.md` | Note the fix | Modify — add one bullet under Unreleased |

No new runtime dependencies. No new files outside the ones above.

---

## Task 1: Write failing tests for the new `runtimeInstall` helper

**Files:**
- Create: `tests/unit/runtimeInstall.test.js`

The tests pin down the contract of the new helper. The two runtime hook files (`sqliteRuntime.js`, `trayRuntime.js`) are **not** changed in this task — the test imports `./cli/hooks/runtimeInstall.js` directly, which does not exist yet, so every test will fail with `Cannot find module`.

The test file uses a fake `npm` (a tiny Node.js script) on `PATH` so it exercises the real `runNpmInstall` wrapper without contacting the network. The fake writes its `cwd` and `argv` to a JSON log so the test can assert on the exact command line. The same fake is reused for the failure case by making it exit with code 1.

- [ ] **Step 1: Create the test file**

Write `tests/unit/runtimeInstall.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const RUNTIME_HELPER = "../../cli/hooks/runtimeInstall.js";
const SQLITE_HOOK = "../../cli/hooks/sqliteRuntime.js";

let originalPath;
let fakeNpmDir;
let dataDir;
let logPath;

function makeFakeNpm() {
  const npmPath = path.join(fakeNpmDir, "npm");
  const body =
    "#!/usr/bin/env node\n" +
    "const fs = require('fs');\n" +
    "fs.writeFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({\n" +
    "  cwd: process.cwd(),\n" +
    "  argv: process.argv.slice(2)\n" +
    "}));\n" +
    "process.exit(0);\n";
  fs.writeFileSync(npmPath, body);
  fs.chmodSync(npmPath, 0o755);

  // On Windows, also provide a .cmd wrapper that calls the Node script
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(fakeNpmDir, "npm.cmd"),
      `@echo off\r\nnode "%~dp0npm" %*\r\n`
    );
  }
}

function makeFailingFakeNpm() {
  const npmPath = path.join(fakeNpmDir, "npm");
  const body =
    "#!/usr/bin/env node\n" +
    "const fs = require('fs');\n" +
    "fs.writeFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({\n" +
    "  cwd: process.cwd(),\n" +
    "  argv: process.argv.slice(2)\n" +
    "}));\n" +
    "process.stderr.write('npm ERR! fake failure\\n');\n" +
    "process.exit(1);\n";
  fs.writeFileSync(npmPath, body);
  fs.chmodSync(npmPath, 0o755);

  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(fakeNpmDir, "npm.cmd"),
      `@echo off\r\nnode "%~dp0npm" %*\r\n`
    );
  }
}

beforeEach(() => {
  originalPath = process.env.PATH;
  fakeNpmDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-fake-npm-"));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-runtime-test-"));
  logPath = path.join(fakeNpmDir, "npm-log.json");

  process.env.DATA_DIR = dataDir;
  process.env.FAKE_NPM_LOG = logPath;
  process.env.PATH = `${fakeNpmDir}${path.delimiter}${process.env.PATH}`;
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.DATA_DIR;
  delete process.env.FAKE_NPM_LOG;
  vi.restoreAllMocks();
  fs.rmSync(fakeNpmDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("runtimeInstall helper", () => {
  it("ensureRuntimeDir creates the runtime dir and a minimal package.json", async () => {
    const { ensureRuntimeDir } = await import(RUNTIME_HELPER);

    const runtimeDir = ensureRuntimeDir();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8")
    );

    expect(runtimeDir).toBe(path.join(dataDir, "runtime"));
    expect(pkg).toMatchObject({
      name: "9router-runtime",
      version: "1.0.0",
      private: true,
    });
  });

  it("installRuntimePackages invokes npm without --no-save", async () => {
    makeFakeNpm();
    const { installRuntimePackages } = await import(RUNTIME_HELPER);

    const ok = installRuntimePackages(["better-sqlite3@12.6.2"], {
      silent: true,
    });

    expect(ok).toBe(true);
    const captured = JSON.parse(fs.readFileSync(logPath, "utf8"));
    expect(captured.cwd).toBe(path.join(dataDir, "runtime"));
    expect(captured.argv).toEqual([
      "install",
      "better-sqlite3@12.6.2",
      "--no-audit",
      "--no-fund",
      "--prefer-online",
    ]);
    expect(captured.argv).not.toContain("--no-save");
  });

  it("installRuntimePackages logs a package-specific warning on failure", async () => {
    makeFailingFakeNpm();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { installRuntimePackages } = await import(RUNTIME_HELPER);

    const ok = installRuntimePackages(["systray2@2.1.4"], {
      silent: false,
      timeout: 120000,
      label: "system tray",
      failureTitle: "System tray install failed — tray disabled",
      failureHint: "tray disabled",
    });

    expect(ok).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️  System tray install failed — tray disabled"
    );
  });

  it("sqliteRuntime re-exports the runtime primitives for existing callers", async () => {
    // Use a CJS require so we get the actual module.exports of the file
    // (the sqlite hook is CommonJS in production).
    const { createRequire } = await import("module");
    const req = createRequire(import.meta.url);
    const sqliteHook = req(SQLITE_HOOK);

    expect(typeof sqliteHook.getRuntimeDir).toBe("function");
    expect(typeof sqliteHook.getRuntimeNodeModules).toBe("function");
    expect(typeof sqliteHook.runNpmInstall).toBe("function");
    expect(typeof sqliteHook.summarizeNpmError).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test and verify it FAILS**

Run: `cd tests && npm test -- runtimeInstall.test.js`

Expected: FAIL. Every test should fail because `cli/hooks/runtimeInstall.js` does not exist. The error will be a `Failed to resolve import` / `Cannot find module` from the dynamic `import(RUNTIME_HELPER)`.

If any test PASSES, the helper already exists — stop, investigate, and confirm you are on the right base branch.

- [ ] **Step 3: Commit the failing test**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add tests/unit/runtimeInstall.test.js
git commit -m "test(runtimeInstall): add failing test for shared runtime install helper

Covers ensureRuntimeDir manifest creation, no --no-save install,
package-specific failure logging, and sqliteRuntime re-exports.
Fails because cli/hooks/runtimeInstall.js does not exist yet.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Implement `cli/hooks/runtimeInstall.js` to make the tests pass

**Files:**
- Create: `cli/hooks/runtimeInstall.js`

This is the shared runtime helper. It owns the primitives, runs npm without `--no-save`, and produces package-specific failure logs.

- [ ] **Step 1: Create the runtimeInstall.js file**

Write `cli/hooks/runtimeInstall.js`:

```js
// Shared runtime install helper.
//
// Owns the user-writable runtime directory under DATA_DIR (or the platform
// default), the npm install wrapper, and the package-specific install logging
// used by cli/hooks/sqliteRuntime.js and cli/hooks/trayRuntime.js.
//
// Keeping a single install wrapper ensures the --no-save flag is never passed
// for runtime installs: each install writes to package.json dependencies, so
// later installs no longer treat earlier runtime packages as extraneous and
// do not prune them.
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
    // Minimal package.json so npm treats this as a project root and writes
    // installed packages under dependencies. npm will add the dependencies
    // key automatically on the first saved install.
    fs.writeFileSync(pkgPath, JSON.stringify({
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
  getDataDir,
  getRuntimeDir,
  getRuntimeNodeModules,
  installRuntimePackages,
  runNpmInstall,
  summarizeNpmError,
};
```

- [ ] **Step 2: Run the test and verify it PASSES**

Run: `cd tests && npm test -- runtimeInstall.test.js`

Expected: PASS. All four tests in the file should be green.

If any test fails, the most common cause is `npm` not being on PATH in the test subprocess — confirm by reading the captured log file in `fakeNpmDir/npm-log.json`. The fake `npm` script should have written it.

- [ ] **Step 3: Commit the implementation**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add cli/hooks/runtimeInstall.js
git commit -m "feat(runtimeInstall): add shared runtime install helper

Centralizes the user-writable runtime directory, npm install wrapper,
and package-specific install logging used by both the SQLite and tray
runtime hooks. Drops --no-save so npm records each runtime package in
package.json dependencies, preventing the systray2 install from pruning
better-sqlite3.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Migrate `cli/hooks/sqliteRuntime.js` to use the shared helper

**Files:**
- Modify: `cli/hooks/sqliteRuntime.js`

The current `sqliteRuntime.js` defines its own copies of `getDataDir`, `getRuntimeDir`, `getRuntimeNodeModules`, `ensureRuntimeDir`, `summarizeNpmError`, `runNpmInstall`, and `npmInstall`. After the refactor it imports the shared ones and re-exports the public primitives that `trayRuntime.js` and `cli/src/cli/tray/tray.js` already import.

- [ ] **Step 1: Replace the require block and the top helpers**

In `cli/hooks/sqliteRuntime.js`, replace the block from the top of the file through `function summarizeNpmError(...)` (the local `getDataDir`, `getRuntimeDir`, `getRuntimeNodeModules`, `ensureRuntimeDir`, `hasModule`, `isBetterSqliteBinaryValid`, and `summarizeNpmError` definitions) with:

```js
// Ensure better-sqlite3 is installed in USER_DATA_DIR/runtime/node_modules
// (user-writable, avoids Windows EBUSY locks during npm i -g updates).
// sql.js is bundled in bin/app already; node:sqlite / bun:sqlite are built-in.
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

// `hasModule` and `isBetterSqliteBinaryValid` are SQLite-specific, so they
// stay local to this file. The shared helper re-exports the same
// getRuntimeDir / getRuntimeNodeModules / runNpmInstall / summarizeNpmError
// surface that other files already import from this module.
function hasModule(name) {
  return fs.existsSync(path.join(getRuntimeNodeModules(), name, "package.json"));
}

function isBetterSqliteBinaryValid() {
  const binary = path.join(getRuntimeNodeModules(), "better-sqlite3", "build", "Release", "better_sqlite3.node");
  if (!fs.existsSync(binary)) return false;
  try {
    const fd = fs.openSync(binary, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.toString("hex");
    if (process.platform === "linux") return magic.startsWith("7f454c46");
    if (process.platform === "darwin") return magic.startsWith("cffaedfe") || magic.startsWith("cefaedfe");
    if (process.platform === "win32") return magic.startsWith("4d5a");
    return true;
  } catch { return false; }
}
```

- [ ] **Step 2: Remove the local `runNpmInstall` and `npmInstall` and update the install call**

In the same file, delete the entire local definitions of `runNpmInstall` (the one that builds `args = ["install", ...pkgs, "--no-audit", ...]`) and `npmInstall` (the wrapper that calls `runNpmInstall` with `extraArgs: ["--no-save"]` when `opts.optional` is set).

Inside `ensureSqliteRuntime()`, replace the call:

```js
const ok = installRuntimePackages([`better-sqlite3@${BETTER_SQLITE3_VERSION}`], {
  silent,
  label: "SQLite engine",
  failureTitle: "SQLite engine install failed — using fallback",
  failureHint: "using fallback",
});
```

The rest of `ensureSqliteRuntime()` is unchanged (the `needBetterSqlite` check, the return shape, the fallback messaging).

- [ ] **Step 3: Run all runtime install tests and verify they pass**

Run: `cd tests && npm test -- runtimeInstall.test.js`

Expected: PASS. The re-exports test in particular must still pass — it asserts that `sqliteRuntime` still exposes `getRuntimeDir`, `getRuntimeNodeModules`, `runNpmInstall`, and `summarizeNpmError`.

- [ ] **Step 4: Verify `--no-save` no longer appears in `cli/hooks/sqliteRuntime.js`**

Run: `grep -n "no-save" cli/hooks/sqliteRuntime.js || echo OK`

Expected: `OK` (no matches).

- [ ] **Step 5: Commit the migration**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add cli/hooks/sqliteRuntime.js
git commit -m "refactor(sqliteRuntime): delegate runtime helpers to runtimeInstall

Removes the local getDataDir/getRuntimeDir/getRuntimeNodeModules/ensureRuntimeDir/
runNpmInstall/summarizeNpmError/npmInstall duplicates. The shared helper
provides the same primitives; sqliteRuntime re-exports them so existing
imports from trayRuntime and cli/src/cli/tray/tray keep working.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Migrate `cli/hooks/trayRuntime.js` to use the shared helper

**Files:**
- Modify: `cli/hooks/trayRuntime.js`

The current `trayRuntime.js` imports `getRuntimeDir`, `getRuntimeNodeModules`, `runNpmInstall`, and `summarizeNpmError` from `sqliteRuntime`, and defines its own `ensureRuntimeDir` and `npmInstall` duplicates. After the refactor it imports from `runtimeInstall.js` directly. `getRuntimeDir` is no longer used in `trayRuntime.js` (it was only consumed by the now-removed local `ensureRuntimeDir`).

- [ ] **Step 1: Replace the require block at the top of the file**

In `cli/hooks/trayRuntime.js`, replace the line:

```js
const { getRuntimeDir, getRuntimeNodeModules, runNpmInstall, summarizeNpmError } = require("./sqliteRuntime");
```

with:

```js
const {
  getRuntimeNodeModules,
  installRuntimePackages,
} = require("./runtimeInstall");
```

- [ ] **Step 2: Remove the local `ensureRuntimeDir` and `npmInstall` and update the install call**

Delete the entire local definitions of `ensureRuntimeDir` and `npmInstall` (the two functions that hardcode `extraArgs: ["--no-save"]` for the tray install).

Inside `ensureTrayRuntime()`, replace the call:

```js
const ok = installRuntimePackages([`${SYSTRAY_PKG}@${SYSTRAY_VERSION}`], {
  silent,
  timeout: 120000,
  label: "system tray",
  failureTitle: "System tray install failed — tray disabled",
  failureHint: "tray disabled",
});
```

The `cleanupLegacySystray`, `hasSystray`, `chmodSystrayBin`, and the rest of `ensureTrayRuntime` are unchanged. The `module.exports = { ensureTrayRuntime };` at the bottom stays the same.

- [ ] **Step 3: Run the runtime install tests and verify they pass**

Run: `cd tests && npm test -- runtimeInstall.test.js`

Expected: PASS. The shared helper tests must still pass after the tray refactor.

- [ ] **Step 4: Verify no `--no-save` remains in `cli/hooks/`**

Run: `grep -rn "no-save" cli/hooks/ || echo OK`

Expected: `OK` (no matches). Both the SQLite and tray installs are now saved installs.

- [ ] **Step 5: Commit the migration**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add cli/hooks/trayRuntime.js
git commit -m "refactor(trayRuntime): delegate runtime helpers to runtimeInstall

Removes the local ensureRuntimeDir/npmInstall duplicates. Imports the
shared install helper from cli/hooks/runtimeInstall so the systray2
install writes its dependency into package.json and no longer prunes
better-sqlite3 installed earlier by ensureSqliteRuntime.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Add a CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a single bullet under the Unreleased section**

In `CHANGELOG.md`, find the `## Unreleased` (or next version) heading and add a bullet to its `### Features` (or `### Fixes`) subsection. Match the existing style of the file. The bullet should read:

```markdown
- Fix runtime installs in `~/.9router/runtime` pruning sibling packages. The SQLite (`better-sqlite3`) and tray (`systray2`) lazy installs now save to `package.json` instead of passing `--no-save`, so the second install no longer prunes the first.
```

If the file uses `## Features` directly under a version (as previous versions do), put the bullet there.

- [ ] **Step 2: Commit the changelog entry**

```bash
cd /Users/hodtien/sourcecodes/github-code/9router
git add CHANGELOG.md
git commit -m "docs(changelog): note runtime install prune fix

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All four design requirements map to tasks: (1) shared helper in `cli/hooks/runtimeInstall.js` → Task 2; (2) drop `--no-save` → Tasks 3 + 4; (3) dedupe `ensureRuntimeDir` / `npmInstall` → Tasks 3 + 4; (4) test file → Task 1. Changelog → Task 5.
- [x] **Placeholder scan:** No "TBD", "TODO", "implement later", or vague requirements in any step. Every code step includes the full file content.
- [x] **Type / name consistency:** The shared helper exposes `ensureRuntimeDir`, `installRuntimePackages`, `getDataDir`, `getRuntimeDir`, `getRuntimeNodeModules`, `runNpmInstall`, `summarizeNpmError`. The SQLite and tray hooks import only what they use. The test file uses the same names.
- [x] **Backward compat:** `sqliteRuntime.js` still exports `getRuntimeDir`, `getRuntimeNodeModules`, `runNpmInstall`, `summarizeNpmError` (test 4 in Task 1 pins this down).
- [x] **No circular imports:** `cli/hooks/runtimeInstall.js` has no `require` of `cli/hooks/sqliteRuntime.js` or `cli/hooks/trayRuntime.js`. `sqliteRuntime.js` and `trayRuntime.js` only require `./runtimeInstall`.

## Out of Scope (per spec)

- Running real `npm install better-sqlite3` or `npm install systray2` in unit tests
- Changing package versions
- Changing where the runtime directory lives
- Changing SQLite fallback behavior when native install fails
- Changing tray behavior on Windows
- Adding a postinstall self-test that loads both modules after install
