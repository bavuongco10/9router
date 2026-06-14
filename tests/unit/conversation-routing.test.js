import { describe, it, expect, beforeEach } from "vitest";

import {
  deriveConversationKey,
  pickConversationConnection,
  resetConversationRouting,
} from "../../src/sse/services/conversationRouting.js";

// Helper: build connections (priority-sorted ascending, as getProviderConnections returns).
function conns(...specs) {
  return specs.map(([id, weight, priority]) => ({ id, weight, priority }));
}

function headers(map = {}) {
  return { get: (n) => map[n.toLowerCase()] ?? null };
}

describe("conversation-routing — weighted round-robin assignment", () => {
  beforeEach(() => resetConversationRouting());

  it("weight=1 rotates each new conversation to the next connection", () => {
    const available = conns(["A", 1, 1], ["B", 1, 2]);
    const picks = ["k1", "k2", "k3", "k4"].map(
      (key) => pickConversationConnection(available, "claude", key).id
    );
    expect(picks).toEqual(["A", "B", "A", "B"]);
  });

  it("weight=3 sticks 3 new conversations to a connection before advancing", () => {
    const available = conns(["A", 3, 1], ["B", 3, 2]);
    const picks = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"].map(
      (key) => pickConversationConnection(available, "claude", key).id
    );
    expect(picks).toEqual(["A", "A", "A", "B", "B", "B", "A"]);
  });

  it("treats missing/invalid weight as 1", () => {
    const available = [
      { id: "A", priority: 1 }, // no weight
      { id: "B", weight: 0, priority: 2 }, // invalid -> 1
    ];
    const picks = ["k1", "k2", "k3"].map(
      (key) => pickConversationConnection(available, "claude", key).id
    );
    expect(picks).toEqual(["A", "B", "A"]);
  });

  it("respects priority order (rotation follows the sorted list)", () => {
    const available = conns(["A", 1, 1], ["B", 1, 2], ["C", 1, 3]);
    const picks = ["k1", "k2", "k3", "k4"].map(
      (key) => pickConversationConnection(available, "claude", key).id
    );
    expect(picks).toEqual(["A", "B", "C", "A"]);
  });

  it("tracks weighted cursor independently per provider", () => {
    const a = conns(["A", 1, 1], ["B", 1, 2]);
    expect(pickConversationConnection(a, "claude", "c1").id).toBe("A");
    expect(pickConversationConnection(a, "codex", "x1").id).toBe("A");
    expect(pickConversationConnection(a, "claude", "c2").id).toBe("B");
    expect(pickConversationConnection(a, "codex", "x2").id).toBe("B");
  });
});

describe("conversation-routing — stickiness", () => {
  beforeEach(() => resetConversationRouting());

  it("returns the same connection for every turn of one conversation", () => {
    const available = conns(["A", 1, 1], ["B", 1, 2]);
    const first = pickConversationConnection(available, "claude", "same").id; // A
    pickConversationConnection(available, "claude", "other"); // advances cursor to B
    // Repeated turns of "same" must stay pinned regardless of cursor movement.
    expect(pickConversationConnection(available, "claude", "same").id).toBe(first);
    expect(pickConversationConnection(available, "claude", "same").id).toBe(first);
  });

  it("re-pins a conversation when its connection becomes unavailable", () => {
    const all = conns(["A", 1, 1], ["B", 1, 2]);
    expect(pickConversationConnection(all, "claude", "k").id).toBe("A");
    // A excluded (e.g. failed -> added to excludeConnectionIds): only B available.
    const repin = pickConversationConnection(conns(["B", 1, 2]), "claude", "k").id;
    expect(repin).toBe("B");
    // Subsequent turns with A available again stay on the re-pinned B.
    expect(pickConversationConnection(all, "claude", "k").id).toBe("B");
  });

  it("returns null when no connections are available", () => {
    expect(pickConversationConnection([], "claude", "k")).toBeNull();
  });

  it("resetConversationRouting(provider) clears only that provider", () => {
    const a = conns(["A", 1, 1], ["B", 1, 2]);
    pickConversationConnection(a, "claude", "c1"); // claude cursor -> A
    pickConversationConnection(a, "codex", "x1"); // codex cursor -> A
    resetConversationRouting("claude");
    // claude restarts at A; codex continues to B.
    expect(pickConversationConnection(a, "claude", "c2").id).toBe("A");
    expect(pickConversationConnection(a, "codex", "x2").id).toBe("B");
  });
});

describe("conversation-routing — deriveConversationKey", () => {
  const body = {
    system: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi!" },
    ],
  };

  it("is stable across turns (same system + first user message)", () => {
    const turn1 = deriveConversationKey({ provider: "claude", model: "m", body, headers: headers() });
    const laterBody = {
      ...body,
      messages: [...body.messages, { role: "user", content: "follow up question" }],
    };
    const turn2 = deriveConversationKey({ provider: "claude", model: "m", body: laterBody, headers: headers() });
    expect(turn1).toBe(turn2);
    expect(turn1).toMatch(/^claude:/);
  });

  it("changes when the first user message changes", () => {
    const other = { ...body, messages: [{ role: "user", content: "different start" }] };
    expect(deriveConversationKey({ provider: "claude", model: "m", body, headers: headers() }))
      .not.toBe(deriveConversationKey({ provider: "claude", model: "m", body: other, headers: headers() }));
  });

  it("changes when the system prompt changes", () => {
    const other = { ...body, system: "You are a pirate." };
    expect(deriveConversationKey({ provider: "claude", model: "m", body, headers: headers() }))
      .not.toBe(deriveConversationKey({ provider: "claude", model: "m", body: other, headers: headers() }));
  });

  it("honors an explicit x-conversation-id header (body-independent)", () => {
    const h = headers({ "x-conversation-id": "conv-123" });
    const k1 = deriveConversationKey({ provider: "claude", model: "m", body, headers: h });
    const k2 = deriveConversationKey({ provider: "claude", model: "m2", body: { system: "x" }, headers: h });
    expect(k1).toBe("claude:conv-123");
    expect(k2).toBe("claude:conv-123");
  });

  it("handles content-array message shapes", () => {
    const arrBody = {
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: [{ type: "text", text: "block hello" }] }],
    };
    const k = deriveConversationKey({ provider: "claude", model: "m", body: arrBody, headers: headers() });
    expect(k).toMatch(/^claude:/);
  });

  it("returns null when nothing usable can be derived", () => {
    expect(deriveConversationKey({ provider: "claude", model: "m", body: {}, headers: headers() })).toBeNull();
    expect(deriveConversationKey({ provider: "claude", model: "m", body: { messages: [] }, headers: headers() })).toBeNull();
  });
});
