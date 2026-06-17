/**
 * Unit tests for scrubStaleThinkingBlocks().
 *
 * Verifies that the request-side scrub:
 *  - drops blocks carrying DEFAULT_THINKING_CLAUDE_SIGNATURE (pre-#952 leftover)
 *  - drops blocks with missing or implausibly short signatures
 *  - preserves blocks with a real-looking signature
 *  - only runs for provider === "claude" (real Anthropic upstream)
 *  - leaves user messages and non-thinking blocks untouched
 *  - tolerates malformed bodies (no messages, string content, etc.)
 */

import { describe, it, expect } from "vitest";
import { scrubStaleThinkingBlocks } from "open-sse/translator/formats/claude.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "open-sse/config/defaultThinkingSignature.js";

const REAL_SIG = "EpYBCkYIBxgCKkBz" + "x".repeat(120); // plausible Anthropic signature shape (>40 chars)

function assistantWithThinking(signature) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm.", signature },
      { type: "text", text: "answer" },
    ],
  };
}

describe("scrubStaleThinkingBlocks", () => {
  it("drops thinking blocks with the pre-#952 placeholder signature", () => {
    const body = { messages: [assistantWithThinking(DEFAULT_THINKING_CLAUDE_SIGNATURE)] };
    scrubStaleThinkingBlocks(body, "claude");
    expect(body.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("drops thinking blocks with a missing signature", () => {
    const body = { messages: [assistantWithThinking(undefined)] };
    scrubStaleThinkingBlocks(body, "claude");
    expect(body.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("drops thinking blocks with an implausibly short signature", () => {
    const body = { messages: [assistantWithThinking("short")] };
    scrubStaleThinkingBlocks(body, "claude");
    expect(body.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("preserves thinking blocks with a real-looking signature", () => {
    const body = { messages: [assistantWithThinking(REAL_SIG)] };
    scrubStaleThinkingBlocks(body, "claude");
    expect(body.messages[0].content).toEqual([
      { type: "thinking", thinking: "hmm.", signature: REAL_SIG },
      { type: "text", text: "answer" },
    ]);
  });

  it("drops redacted_thinking blocks with the placeholder signature", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "x", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE },
          { type: "text", text: "answer" },
        ],
      }],
    };
    scrubStaleThinkingBlocks(body, "claude");
    expect(body.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("is a no-op for anthropic-compatible providers (they don't validate signatures)", () => {
    const body = { messages: [assistantWithThinking(DEFAULT_THINKING_CLAUDE_SIGNATURE)] };
    scrubStaleThinkingBlocks(body, "anthropic-compatible-zai");
    expect(body.messages[0].content[0].type).toBe("thinking");
    expect(body.messages[0].content[0].signature).toBe(DEFAULT_THINKING_CLAUDE_SIGNATURE);
  });

  it("is a no-op for non-claude providers", () => {
    const body = { messages: [assistantWithThinking(DEFAULT_THINKING_CLAUDE_SIGNATURE)] };
    scrubStaleThinkingBlocks(body, "gemini");
    expect(body.messages[0].content[0].type).toBe("thinking");
  });

  it("leaves user messages untouched", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: ".", signature: "short" }] },
      ],
    };
    scrubStaleThinkingBlocks(body, "claude");
    expect(body.messages[0].content).toEqual([{ type: "text", text: "hi" }]);
    expect(body.messages[1].content).toEqual([]);
  });

  it("preserves tool_use and text blocks alongside thinking", () => {
    const body = {
      messages: [{
        role: "assistant",
        content: [
          { type: "thinking", thinking: ".", signature: DEFAULT_THINKING_CLAUDE_SIGNATURE },
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "t1", name: "read", input: {} },
        ],
      }],
    };
    scrubStaleThinkingBlocks(body, "claude");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "calling tool" },
      { type: "tool_use", id: "t1", name: "read", input: {} },
    ]);
  });

  it("tolerates string content on a message", () => {
    const body = {
      messages: [
        { role: "assistant", content: "plain text reply" },
        assistantWithThinking(DEFAULT_THINKING_CLAUDE_SIGNATURE),
      ],
    };
    scrubStaleThinkingBlocks(body, "claude");
    expect(body.messages[0].content).toBe("plain text reply");
    expect(body.messages[1].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("tolerates an absent messages array", () => {
    const body = {};
    expect(() => scrubStaleThinkingBlocks(body, "claude")).not.toThrow();
    expect(body).toEqual({});
  });

  it("tolerates null body", () => {
    expect(() => scrubStaleThinkingBlocks(null, "claude")).not.toThrow();
  });
});
