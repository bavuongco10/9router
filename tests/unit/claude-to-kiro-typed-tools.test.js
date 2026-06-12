/**
 * Unit tests for typed-tool downgrade in claude-to-kiro.js (kr/ direct route).
 *
 * Anthropic typed tools (e.g. {type: "web_search_20250305", name: "web_search"})
 * must NOT be filtered out — Kiro has no native typed-tool support, so the
 * registry downgrades each typed entry to a custom-tool shape with a real
 * input schema. Without this the model can never emit a tool_use for the
 * typed family.
 */
import { describe, it, expect } from "vitest";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";

const MODEL = "claude-sonnet-4.5";

function specsOf(out) {
  const cur = out.conversationState.currentMessage.userInputMessage;
  return cur.userInputMessageContext?.tools || [];
}

describe("claude-to-kiro typed-tool downgrade", () => {
  it("downgrades web_search_20250305 to a custom-tool spec with the query schema", () => {
    const out = claudeToKiroRequest(MODEL, {
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "find docs" }],
    }, true, {});

    const specs = specsOf(out);
    expect(specs).toHaveLength(1);
    expect(specs[0].toolSpecification.name).toBe("web_search");
    expect(specs[0].toolSpecification.inputSchema.json.required).toEqual(["query"]);
    expect(specs[0].toolSpecification.inputSchema.json.properties.query.type).toBe("string");
  });

  it("downgrades bash_20250124 to a bash custom-tool spec", () => {
    const out = claudeToKiroRequest(MODEL, {
      tools: [{ type: "bash_20250124", name: "bash" }],
      messages: [{ role: "user", content: "run something" }],
    }, true, {});

    const specs = specsOf(out);
    expect(specs).toHaveLength(1);
    expect(specs[0].toolSpecification.name).toBe("bash");
    expect(specs[0].toolSpecification.inputSchema.json.properties.command.type).toBe("string");
    // bash schema has no required[] entries; normalization should still emit [].
    expect(specs[0].toolSpecification.inputSchema.json.required).toEqual([]);
  });

  it("uses family default name when text_editor_20250728 omits `name`", () => {
    const out = claudeToKiroRequest(MODEL, {
      tools: [{ type: "text_editor_20250728" }],
      messages: [{ role: "user", content: "edit" }],
    }, true, {});

    const specs = specsOf(out);
    expect(specs).toHaveLength(1);
    expect(specs[0].toolSpecification.name).toBe("str_replace_based_edit_tool");
    expect(specs[0].toolSpecification.inputSchema.json.required).toEqual(["command", "path"]);
  });

  it("downgrades code_execution_20250522 (does NOT reject — client-loop fallback)", () => {
    const out = claudeToKiroRequest(MODEL, {
      tools: [{ type: "code_execution_20250522", name: "code_execution" }],
      messages: [{ role: "user", content: "run" }],
    }, true, {});

    const specs = specsOf(out);
    expect(specs).toHaveLength(1);
    expect(specs[0].toolSpecification.name).toBe("code_execution");
    expect(specs[0].toolSpecification.inputSchema.json.required).toEqual(["code"]);
  });

  it("throws UNSUPPORTED_TOOL_TYPE for an unknown typed tool", () => {
    expect(() =>
      claudeToKiroRequest(MODEL, {
        tools: [{ type: "made_up_tool_20990101", name: "x" }],
        messages: [{ role: "user", content: "hi" }],
      }, true, {})
    ).toThrow(/UNSUPPORTED_TOOL_TYPE: made_up_tool_20990101/);
  });

  it("custom tool path is unchanged: name + input_schema produce the same spec", () => {
    const out = claudeToKiroRequest(MODEL, {
      tools: [{
        name: "my_tool",
        description: "do thing",
        input_schema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
      }],
      messages: [{ role: "user", content: "hi" }],
    }, true, {});

    const specs = specsOf(out);
    expect(specs).toHaveLength(1);
    expect(specs[0].toolSpecification.name).toBe("my_tool");
    expect(specs[0].toolSpecification.description).toBe("do thing");
    expect(specs[0].toolSpecification.inputSchema.json.required).toEqual(["x"]);
    expect(specs[0].toolSpecification.inputSchema.json.properties.x.type).toBe("string");
  });

  it("mixed typed + custom tools produce both specs in order", () => {
    const out = claudeToKiroRequest(MODEL, {
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { name: "my_tool", input_schema: { type: "object", properties: {} } },
      ],
      messages: [{ role: "user", content: "go" }],
    }, true, {});

    const specs = specsOf(out);
    expect(specs).toHaveLength(2);
    expect(specs[0].toolSpecification.name).toBe("web_search");
    expect(specs[0].toolSpecification.inputSchema.json.required).toEqual(["query"]);
    expect(specs[1].toolSpecification.name).toBe("my_tool");
  });
});
