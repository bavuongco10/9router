/**
 * Unit tests for open-sse/translator/request/openai-to-kiro.js
 *
 * Tests cover:
 *  - buildKiroPayload() - basic message conversion
 *  - Image forwarding fix: images in currentMessage must be included in payload
 */

import { describe, it, expect } from "vitest";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";

describe("buildKiroPayload", () => {
  describe("basic message conversion", () => {
    it("should convert a simple text message", () => {
      const body = {
        messages: [{ role: "user", content: "Hello" }]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.content).toContain("Hello");
      expect(currentMsg.userInputMessage.modelId).toBe("claude-sonnet-4.6");
      expect(currentMsg.userInputMessage.origin).toBe("AI_EDITOR");
    });

    it("should not include images field when no images are present", () => {
      const body = {
        messages: [{ role: "user", content: "No images here" }]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeUndefined();
    });
  });

  describe("model suffix handling", () => {
    it("should reject Anthropic-only 1m context suffixes before Kiro upstream", () => {
      const body = {
        messages: [{ role: "user", content: "Hello" }]
      };

      expect(() => buildKiroPayload("claude-opus-4.7-thinking-agentic[1m]", body, true, {}))
        .toThrow("[kr/*] '[1m]' suffix is not supported by Kiro upstream");
    });
  });

  describe("agentic chunked-write protocol placement", () => {
    // The agentic prompt is a one-shot system instruction. Sending it on
    // every user turn pollutes Kiro's history view, wastes tokens, and bleeds
    // the protocol into downstream context. Anchor it in the leading turn.
    it("multi-turn: protocol lives in leading history turn, not currentMessage or later turns", () => {
      const body = {
        messages: [
          { role: "system", content: "be concise" },
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      };

      const result = buildKiroPayload("claude-sonnet-4.5-agentic", body, true, {});
      const cur = result.conversationState.currentMessage.userInputMessage.content;
      const history = result.conversationState.history || [];
      const leading = history[0]?.userInputMessage?.content || "";
      const laterHistTxt = history.slice(1).map((h) => h?.userInputMessage?.content || "").join("\n");

      expect(leading).toContain("CHUNKED WRITE PROTOCOL");
      expect(cur).not.toContain("CHUNKED WRITE PROTOCOL");
      expect(laterHistTxt).not.toContain("CHUNKED WRITE PROTOCOL");
    });

    it("single-turn: no history → protocol attaches to currentMessage as fallback", () => {
      const body = { messages: [{ role: "user", content: "hi" }] };
      const result = buildKiroPayload("claude-sonnet-4.5-agentic", body, true, {});
      const cur = result.conversationState.currentMessage.userInputMessage.content;
      const history = result.conversationState.history || [];

      expect(history.length).toBe(0);
      expect(cur).toContain("CHUNKED WRITE PROTOCOL");
    });

    it("non-agentic model: protocol absent from history and currentMessage", () => {
      const body = {
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      };
      const result = buildKiroPayload("claude-sonnet-4.5", body, true, {});
      const cur = result.conversationState.currentMessage.userInputMessage.content;
      const histTxt = (result.conversationState.history || [])
        .map((h) => h?.userInputMessage?.content || "")
        .join("\n");

      expect(cur).not.toContain("CHUNKED WRITE PROTOCOL");
      expect(histTxt).not.toContain("CHUNKED WRITE PROTOCOL");
    });
  });

  describe("image forwarding", () => {
    it("should forward base64 image from image_url content part", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this image" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeDefined();
      expect(currentMsg.userInputMessage.images).toHaveLength(1);
      expect(currentMsg.userInputMessage.images[0].format).toBe("png");
      expect(currentMsg.userInputMessage.images[0].source.bytes).toBe(fakeBase64);
    });

    it("should forward multiple base64 images", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Compare these images" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${fakeBase64}` } },
              { type: "image_url", image_url: { url: `data:image/png;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toHaveLength(2);
      expect(currentMsg.userInputMessage.images[0].format).toBe("jpeg");
      expect(currentMsg.userInputMessage.images[1].format).toBe("png");
    });

    it("should not include images field when images array is empty", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Just text" }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.images).toBeUndefined();
    });

    it("should include both images and text content together", () => {
      const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: `data:image/jpeg;base64,${fakeBase64}` } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      expect(currentMsg.userInputMessage.content).toContain("What is in this image?");
      expect(currentMsg.userInputMessage.images).toHaveLength(1);
    });

    it("should treat http image URLs as text fallback (Kiro only supports base64)", () => {
      const body = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Look at this" },
              { type: "image_url", image_url: { url: "https://example.com/photo.jpg" } }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});

      const currentMsg = result.conversationState.currentMessage;
      // HTTP URLs are not supported by Kiro — converted to text placeholder
      expect(currentMsg.userInputMessage.images).toBeUndefined();
      expect(currentMsg.userInputMessage.content).toContain("[Image: https://example.com/photo.jpg]");
    });
  });

  describe("tool interaction without client-provided tools", () => {
    // When the client omits `tools` (e.g. after compaction), structured tool
    // content must be flattened to text so Kiro's "tools required" 400 never
    // fires and no phantom tool-calling capability is advertised.

    it("should flatten OpenAI tool_calls + tool result into history text with no tools array", () => {
      const body = {
        messages: [
          { role: "user", content: "Read the file" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }
            ]
          },
          { role: "tool", tool_call_id: "call_1", content: "file contents here" },
          { role: "user", content: "Summarize it" }
        ]
        // note: no `tools`
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const cs = result.conversationState;

      // No structured tool content anywhere
      expect(cs.currentMessage.userInputMessage.userInputMessageContext).toBeUndefined();
      const allJson = JSON.stringify(cs);
      expect(allJson).not.toContain("toolUses");
      expect(allJson).not.toContain("toolResults");

      // Tool call + result preserved as readable text (call lands in history,
      // result merges into the final currentMessage — assert across both)
      expect(allJson).toContain("[Tool call: read_file(");
      expect(allJson).toContain("[Tool result: file contents here]");
    });

    it("should flatten Claude tool_use / tool_result blocks with no tools array", () => {
      const body = {
        messages: [
          { role: "user", content: "Do it" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Calling tool" },
              { type: "tool_use", id: "tu_1", name: "search", input: { q: "kiro" } }
            ]
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tu_1", content: "result text" }
            ]
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const cs = result.conversationState;

      const allJson = JSON.stringify(cs);
      expect(allJson).not.toContain("toolUses");
      expect(allJson).not.toContain("toolResults");
      expect(allJson).toContain("[Tool call: search(");
      expect(allJson).toContain("[Tool result: result text]");
    });

    it("should keep structured tools when the client DOES provide a tools array", () => {
      const body = {
        messages: [
          { role: "user", content: "Read the file" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }
            ]
          },
          { role: "tool", tool_call_id: "call_1", content: "file contents here" },
          { role: "user", content: "Summarize it" }
        ],
        tools: [
          {
            type: "function",
            function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const cs = result.conversationState;

      // Structured tool spec carried on currentMessage
      const tools = cs.currentMessage.userInputMessage.userInputMessageContext?.tools;
      expect(tools).toBeDefined();
      expect(tools[0].toolSpecification.name).toBe("read_file");

      // Structured tool history preserved (not flattened to text)
      const allJson = JSON.stringify(cs);
      expect(allJson).toContain("toolUses");
      expect(allJson).not.toContain("[Tool call:");
    });

    it("should salvage orphaned tool_result content as text instead of discarding it", () => {
      // Client provides tools, but compaction removed the assistant tool_use
      // message, leaving a tool_result whose tool_use_id matches nothing.
      const body = {
        messages: [
          { role: "user", content: "Start" },
          // (assistant tool_use for "orphan_call" was compacted away)
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "orphan_call", content: "important orphaned output" }
            ]
          },
          { role: "user", content: "Now continue" }
        ],
        tools: [
          {
            type: "function",
            function: { name: "some_tool", description: "x", parameters: { type: "object", properties: {}, required: [] } }
          }
        ]
      };

      const result = buildKiroPayload("claude-sonnet-4.6", body, true, {});
      const cs = result.conversationState;
      const allJson = JSON.stringify(cs);

      // The dangling structured reference is gone (would trigger Kiro 400)...
      expect(allJson).not.toContain("orphan_call");
      // ...but the content is preserved as salvaged text, not discarded.
      expect(allJson).toContain("[Tool result: important orphaned output]");
    });
  });
});
