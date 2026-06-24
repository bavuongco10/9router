import { describe, it, expect } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";

// Ollama wire format collapses every reasoning model to a `think` boolean.
// applyThinking runs post-translation on the ollama-shaped body.
describe("applyThinking → ollama native `think`", () => {
  const M = "qwen3:8b"; // matches *qwen* → reasoning:true, thinkingFormat:"qwen"
  const P = "ollama-local";

  it("budget/enabled intent → think:true (overrides qwen dialect)", () => {
    const b = { model: M, messages: [] };
    applyThinking("ollama", M, b, P, { mode: "budget", budget: 10000 });
    expect(b.think).toBe(true);
    expect(b.enable_thinking).toBeUndefined(); // qwen dialect must NOT leak to ollama wire
  });

  it("none intent → think:false", () => {
    const b = { model: M, messages: [] };
    applyThinking("ollama", M, b, P, { mode: "none" });
    expect(b.think).toBe(false);
  });

  it("non-reasoning model → no think field", () => {
    const b = { model: "llama3.2", messages: [] };
    applyThinking("ollama", "llama3.2", b, P, { mode: "budget", budget: 10000 });
    expect("think" in b).toBe(false);
  });
});
