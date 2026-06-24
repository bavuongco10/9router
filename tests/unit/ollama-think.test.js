import { describe, it, expect } from "vitest";
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js";

// qwen3 thinking flag forwarding in openai→ollama (request side).
describe("openai→ollama think forwarding", () => {
  const base = { messages: [{ role: "user", content: "hi" }] };

  it("enabled → think:true", () => {
    expect(openaiToOllamaRequest("qwen3:8b", { ...base, thinking: { type: "enabled" } }, false).think).toBe(true);
  });
  it("reasoning_effort → think:true", () => {
    expect(openaiToOllamaRequest("qwen3:8b", { ...base, reasoning_effort: "high" }, false).think).toBe(true);
  });
  it("disabled → think:false", () => {
    expect(openaiToOllamaRequest("qwen3:8b", { ...base, thinking: { type: "disabled" } }, false).think).toBe(false);
  });
  it("no thinking → omit think", () => {
    expect("think" in openaiToOllamaRequest("qwen3:8b", base, false)).toBe(false);
  });
});
