/**
 * Unit tests for typed-tool downgrade in openai-to-kiro.js (kr/ pivot route).
 *
 * The pivot path normally sees OpenAI-shape tools ({type:"function", function:{...}}),
 * but we add a defensive branch in case a Claude→OpenAI translator stage
 * upstream lets a typed Anthropic tool leak through.
 */
import { describe, it, expect } from "vitest";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";

const MODEL = "claude-sonnet-4.5";

function specsOf(out) {
  const cur = out.conversationState.currentMessage.userInputMessage;
  return cur.userInputMessageContext?.tools || [];
}

describe("openai-to-kiro typed-tool downgrade (defensive)", () => {
  it("downgrades a typed Anthropic tool that leaks through the pivot", () => {
    const out = buildKiroPayload(MODEL, {
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "find docs" }],
    }, true, {});

    const specs = specsOf(out);
    expect(specs).toHaveLength(1);
    expect(specs[0].toolSpecification.name).toBe("web_search");
    expect(specs[0].toolSpecification.inputSchema.json.required).toEqual(["query"]);
  });

  it("regular OpenAI {type:'function', function:{...}} tool is unchanged", () => {
    const out = buildKiroPayload(MODEL, {
      tools: [{
        type: "function",
        function: {
          name: "my_tool",
          description: "do thing",
          parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
        },
      }],
      messages: [{ role: "user", content: "hi" }],
    }, true, {});

    const specs = specsOf(out);
    expect(specs).toHaveLength(1);
    expect(specs[0].toolSpecification.name).toBe("my_tool");
    expect(specs[0].toolSpecification.description).toBe("do thing");
    expect(specs[0].toolSpecification.inputSchema.json.required).toEqual(["x"]);
  });
});
