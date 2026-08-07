import { describe, expect, it } from "vitest";
import { toExportableConnection, sanitizeImportedConnection } from "../../src/lib/connectionShare.js";

const sample = {
  id: "abc-123",
  provider: "claude",
  authType: "oauth",
  name: "Alice",
  email: "alice@example.com",
  refreshToken: "rt_secret",
  accessToken: "at_secret",
  priority: 3,
  globalPriority: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  testStatus: "active",
  lastError: "boom",
  consecutiveUseCount: 5,
  modelLock_foo: "2026-01-03T00:00:00Z",
  providerSpecificData: { username: "alice", proxyPoolId: "pool-9", connectionProxyUrl: "http://x" },
};

describe("connectionShare", () => {
  it("export → import round-trip keeps credentials, drops instance-local fields", () => {
    const exported = toExportableConnection(sample);
    const imported = sanitizeImportedConnection(exported);

    // credentials + identity survive
    expect(imported.refreshToken).toBe("rt_secret");
    expect(imported.accessToken).toBe("at_secret");
    expect(imported.provider).toBe("claude");
    expect(imported.email).toBe("alice@example.com");
    expect(imported.providerSpecificData.username).toBe("alice");

    // instance-local / runtime / proxy fields stripped
    for (const k of ["id", "priority", "globalPriority", "createdAt", "updatedAt", "testStatus", "lastError", "consecutiveUseCount", "modelLock_foo"]) {
      expect(imported[k]).toBeUndefined();
    }
    expect(imported.providerSpecificData.proxyPoolId).toBeUndefined();
    expect(imported.providerSpecificData.connectionProxyUrl).toBeUndefined();
  });

  it("rejects a blob with no credential", () => {
    expect(() => sanitizeImportedConnection({ provider: "claude", name: "x" })).toThrow(/credential/);
  });

  it("rejects a blob with no provider", () => {
    expect(() => sanitizeImportedConnection({ refreshToken: "x" })).toThrow(/provider/);
  });
});
