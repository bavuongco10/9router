import { describe, it, expect } from "vitest";
import { partitionComboModelsByProvider } from "../../src/sse/services/model.js";

describe("partitionComboModelsByProvider", () => {
  it("keeps models whose provider alias resolves to an active provider", () => {
    const active = new Set(["anthropic", "openai"]);
    const { kept, dropped } = partitionComboModelsByProvider(
      ["anthropic/claude-3-5", "openai/gpt-4o"],
      active,
    );
    expect(kept).toEqual(["anthropic/claude-3-5", "openai/gpt-4o"]);
    expect(dropped).toEqual([]);
  });

  it("drops models whose provider has no active connection", () => {
    const active = new Set(["anthropic"]);
    const { kept, dropped } = partitionComboModelsByProvider(
      ["anthropic/claude-3-5", "openai/gpt-4o"],
      active,
    );
    expect(kept).toEqual(["anthropic/claude-3-5"]);
    expect(dropped).toEqual(["openai/gpt-4o"]);
  });

  it("resolves short aliases (cc -> claude) before checking", () => {
    const active = new Set(["claude"]);
    const { kept, dropped } = partitionComboModelsByProvider(
      ["cc/claude-haiku-4-5-20251001"],
      active,
    );
    expect(kept).toEqual(["cc/claude-haiku-4-5-20251001"]);
    expect(dropped).toEqual([]);
  });

  it("keeps entries with unknown alias (custom compat prefix or model alias)", () => {
    const active = new Set(["anthropic"]);
    const { kept } = partitionComboModelsByProvider(
      ["mycompat/some-model", "openai/gpt-4o"],
      active,
    );
    expect(kept).toContain("mycompat/some-model");
    expect(kept).not.toContain("openai/gpt-4o");
  });

  it("treats bare provider name (webSearch/webFetch combo) the same way", () => {
    const active = new Set(["anthropic"]);
    const { kept, dropped } = partitionComboModelsByProvider(
      ["openai", "anthropic"],
      active,
    );
    expect(kept).toEqual(["anthropic"]);
    expect(dropped).toEqual(["openai"]);
  });

  it("handles empty / non-array input safely", () => {
    expect(partitionComboModelsByProvider([], new Set())).toEqual({ kept: [], dropped: [] });
    expect(partitionComboModelsByProvider(null, new Set())).toEqual({ kept: [], dropped: [] });
  });
});
