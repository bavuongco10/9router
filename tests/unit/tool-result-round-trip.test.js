/**
 * T5 — tool_result / multi-turn round-trip tests
 *
 * Verifies that tool_result blocks (and tool_use_id) flow correctly through
 * BOTH the kr/ path (claude-to-kiro and openai-to-kiro) and the cc/ direct
 * passthrough, with id consistency preserved across the request/response
 * boundary.
 *
 * Coverage:
 *   - kr/ inbound: tool_result (string + array content) → Kiro toolResults[]
 *   - kr/ inbound: is_error: true → status: "error" on both paths
 *   - kr/ outbound: tool_use_id from a synthetic Kiro toolUseEvent survives
 *     through to the emitted Claude content_block_start
 *   - cc/ passthrough: prepareClaudeRequest doesn't drop or rewrite
 *     tool_use_id, content, or is_error on user tool_result blocks
 *   - Multi-turn: a [user → assistant tool_use → user tool_result] body lands
 *     the tool_result on currentMessage with the matching toolUseId
 *   - Normalization parity: claude-to-kiro and openai-to-kiro produce
 *     equivalent toolResults shapes for equivalent inputs
 */
import { describe, it, expect } from "vitest";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";
import { buildKiroPayload } from "../../open-sse/translator/request/openai-to-kiro.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { kiroToClaudeResponse } from "../../open-sse/translator/response/kiro-to-claude.js";
import { convertKiroToOpenAI } from "../../open-sse/translator/response/kiro-to-openai.js";

const MODEL = "claude-sonnet-4.5";

// Walk every userInputMessage carrier (history items + currentMessage) and
// return the first toolResults entry whose toolUseId matches.
function findToolResult(payload, toolUseId) {
  const carriers = [
    ...payload.conversationState.history,
    payload.conversationState.currentMessage,
  ];
  for (const item of carriers) {
    const tr = item.userInputMessage?.userInputMessageContext?.toolResults;
    if (!tr) continue;
    const hit = tr.find((x) => x.toolUseId === toolUseId);
    if (hit) return hit;
  }
  return null;
}

// Walk history and find the toolUse with the given id on any assistant turn.
function findToolUse(payload, toolUseId) {
  for (const item of payload.conversationState.history) {
    const arm = item.assistantResponseMessage;
    if (!arm) continue;
    const hit = (arm.toolUses || []).find((tu) => tu.toolUseId === toolUseId);
    if (hit) return hit;
  }
  return null;
}

const TOOL_F = {
  name: "f",
  description: "test tool",
  input_schema: { type: "object", properties: {} },
};

describe("T5 / kr/ inbound — claudeToKiroRequest tool_result handling", () => {
  it("string content: maps to toolResults with status:success and preserves toolUseId", () => {
    const out = claudeToKiroRequest(
      MODEL,
      {
        tools: [TOOL_F],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "f", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }],
          },
        ],
      },
      true,
      {}
    );
    const tr = findToolResult(out, "toolu_1");
    expect(tr).toBeTruthy();
    expect(tr.status).toBe("success");
    expect(tr.content).toEqual([{ text: "42" }]);
  });

  it("is_error:true → status:error", () => {
    const out = claudeToKiroRequest(
      MODEL,
      {
        tools: [TOOL_F],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_e", name: "f", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_e",
                is_error: true,
                content: "boom",
              },
            ],
          },
        ],
      },
      true,
      {}
    );
    const tr = findToolResult(out, "toolu_e");
    expect(tr.status).toBe("error");
    expect(tr.content[0].text).toBe("boom");
  });

  it("array content: filters text blocks and joins with newline", () => {
    const out = claudeToKiroRequest(
      MODEL,
      {
        tools: [TOOL_F],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_a", name: "f", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_a",
                content: [
                  { type: "text", text: "line1" },
                  { type: "text", text: "line2" },
                ],
              },
            ],
          },
        ],
      },
      true,
      {}
    );
    const tr = findToolResult(out, "toolu_a");
    expect(tr.content[0].text).toBe("line1\nline2");
  });

  it("non-text array fallback: empty text-filter result falls through to JSON", () => {
    const out = claudeToKiroRequest(
      MODEL,
      {
        tools: [TOOL_F],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_j", name: "f", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_j",
                content: [{ type: "image", source: { type: "base64", data: "A" } }],
              },
            ],
          },
        ],
      },
      true,
      {}
    );
    const tr = findToolResult(out, "toolu_j");
    expect(tr.content[0].text).toContain("image");
  });
});

describe("T5 / kr/ inbound — buildKiroPayload (openai-to-kiro) tool_result parity", () => {
  it("Claude-shape tool_result via OpenAI pivot: preserves toolUseId + content", () => {
    const out = buildKiroPayload(
      MODEL,
      {
        tools: [
          {
            type: "function",
            function: { name: "f", description: "x", parameters: { type: "object", properties: {} } },
          },
        ],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_p", name: "f", input: {} }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_p", content: "ok" }],
          },
        ],
      },
      true,
      {}
    );
    const tr = findToolResult(out, "toolu_p");
    expect(tr).toBeTruthy();
    expect(tr.status).toBe("success");
    expect(tr.content[0].text).toBe("ok");
  });

  it("is_error:true → status:error (parity with claude-to-kiro)", () => {
    const out = buildKiroPayload(
      MODEL,
      {
        tools: [
          {
            type: "function",
            function: { name: "f", description: "x", parameters: { type: "object", properties: {} } },
          },
        ],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_q", name: "f", input: {} }],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_q",
                is_error: true,
                content: "fail",
              },
            ],
          },
        ],
      },
      true,
      {}
    );
    const tr = findToolResult(out, "toolu_q");
    expect(tr.status).toBe("error");
    expect(tr.content[0].text).toBe("fail");
  });

  it("OpenAI-style role:tool message: maps to toolResults entry with tool_call_id", () => {
    const out = buildKiroPayload(
      MODEL,
      {
        tools: [
          {
            type: "function",
            function: { name: "f", description: "x", parameters: { type: "object", properties: {} } },
          },
        ],
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_o", type: "function", function: { name: "f", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_o", content: "ok" },
        ],
      },
      true,
      {}
    );
    const tr = findToolResult(out, "call_o");
    expect(tr).toBeTruthy();
    expect(tr.status).toBe("success");
    expect(tr.content[0].text).toBe("ok");
  });
});

describe("T5 / kr/ outbound — tool_use_id preservation", () => {
  it("Kiro toolUseEvent → OpenAI tool_call retains toolUseId verbatim", () => {
    const state = {};
    const chunk = {
      _eventType: "toolUseEvent",
      toolUseId: "toolu_xyz",
      name: "f",
      input: { x: 1 },
    };
    const oai = convertKiroToOpenAI(chunk, state);
    expect(oai).toBeTruthy();
    const tc = oai.choices[0].delta.tool_calls[0];
    expect(tc.id).toBe("toolu_xyz");
    expect(tc.function.name).toBe("f");
  });

  it("OpenAI tool_call (carrying Kiro toolUseId) → Claude content_block_start preserves id", () => {
    const state = {};
    // First chunk: tool_call init with id + name. kiroToClaudeResponse expects
    // OpenAI-shaped chunks (KiroExecutor pre-converts AWS EventStream to those).
    const events = kiroToClaudeResponse(
      {
        id: "chatcmpl-x",
        model: "kiro",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "toolu_xyz",
                  type: "function",
                  function: { name: "f", arguments: "" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      state
    );
    const start = events.find(
      (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"
    );
    expect(start).toBeTruthy();
    expect(start.content_block.id).toBe("toolu_xyz");
    expect(start.content_block.name).toBe("f");
  });

  it("end-to-end: Kiro toolUseEvent → OpenAI chunk → Claude SSE keeps the same id", () => {
    // Simulate the real pipeline: Kiro raw event → OpenAI chunk → Claude event.
    // KiroExecutor itself does the first hop in production; here we exercise
    // the same translator pair that runs after the executor.
    const oaiState = {};
    const oaiChunk = convertKiroToOpenAI(
      { _eventType: "toolUseEvent", toolUseId: "toolu_e2e", name: "f", input: { y: 2 } },
      oaiState
    );
    const claudeState = {};
    const events = kiroToClaudeResponse(oaiChunk, claudeState);
    const start = events.find(
      (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"
    );
    expect(start.content_block.id).toBe("toolu_e2e");
  });
});

describe("T5 / cc/ passthrough — prepareClaudeRequest preserves tool_result fields", () => {
  it("user message tool_result blocks survive intact (toolUseId, content, is_error)", () => {
    const body = {
      tools: [TOOL_F],
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_cc", name: "f", input: {} }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_cc",
              is_error: true,
              content: [{ type: "text", text: "fail" }],
            },
          ],
        },
      ],
    };
    const out = prepareClaudeRequest(body, "claude", null, null);
    // Find the tool_result block in the prepared messages.
    let result = null;
    for (const m of out.messages) {
      if (Array.isArray(m.content)) {
        const hit = m.content.find((b) => b.type === "tool_result");
        if (hit) result = hit;
      }
    }
    expect(result).toBeTruthy();
    expect(result.tool_use_id).toBe("toolu_cc");
    expect(result.is_error).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "fail" }]);
  });

  it("string-content tool_result: tool_use_id and content preserved", () => {
    const body = {
      tools: [TOOL_F],
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_s", name: "f", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_s", content: "ok" },
          ],
        },
      ],
    };
    const out = prepareClaudeRequest(body, "claude", null, null);
    let result = null;
    for (const m of out.messages) {
      if (Array.isArray(m.content)) {
        const hit = m.content.find((b) => b.type === "tool_result");
        if (hit) result = hit;
      }
    }
    expect(result).toBeTruthy();
    expect(result.tool_use_id).toBe("toolu_s");
    expect(result.content).toBe("ok");
  });

  it("typed tool in body passes through prepareClaudeRequest without throwing", () => {
    expect(() =>
      prepareClaudeRequest(
        {
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [
            { role: "user", content: "search" },
            {
              role: "assistant",
              content: [
                {
                  type: "server_tool_use",
                  id: "srvtoolu_1",
                  name: "web_search",
                  input: { query: "x" },
                },
                {
                  type: "web_search_tool_result",
                  tool_use_id: "srvtoolu_1",
                  content: [{ type: "web_search_result", url: "https://x", title: "x" }],
                },
              ],
            },
            { role: "user", content: "follow-up" },
          ],
        },
        "claude",
        null,
        null
      )
    ).not.toThrow();
  });
});

describe("T5 / multi-turn fixture — full request round-trip on kr/ path", () => {
  // [user] → [assistant tool_use] → [user tool_result] → [user follow-up]
  // The third turn carries the tool_result; we use a follow-up so currentMessage
  // is the last user turn and history retains the tool_result via merging.
  it("places tool_result on the merged user turn with matching toolUseId", () => {
    const body = {
      tools: [TOOL_F],
      messages: [
        { role: "user", content: "fetch the answer" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling f" },
            { type: "tool_use", id: "toolu_mt", name: "f", input: { q: "life" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_mt", content: "42" },
          ],
        },
        { role: "user", content: "now explain" },
      ],
    };
    const out = claudeToKiroRequest(MODEL, body, true, {});

    // The toolUse should be in history (assistant turn).
    const tu = findToolUse(out, "toolu_mt");
    expect(tu).toBeTruthy();
    expect(tu.name).toBe("f");
    expect(tu.input).toEqual({ q: "life" });

    // The toolResult should be reachable from currentMessage (or its merged
    // history equivalent — it does not matter which carrier holds it as long
    // as the toolUseId aligns with the toolUse above).
    const tr = findToolResult(out, "toolu_mt");
    expect(tr).toBeTruthy();
    expect(tr.content[0].text).toBe("42");
    expect(tr.status).toBe("success");

    // The follow-up user text must be present somewhere in the carrier text.
    const carriers = [
      ...out.conversationState.history,
      out.conversationState.currentMessage,
    ];
    const allText = carriers
      .map((c) => c.userInputMessage?.content || "")
      .join("\n");
    expect(allText).toContain("now explain");
  });

  it("two-turn (no follow-up): tool_result lands on currentMessage", () => {
    const body = {
      tools: [TOOL_F],
      messages: [
        { role: "user", content: "ask" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_2t", name: "f", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_2t", content: "result" },
          ],
        },
      ],
    };
    const out = claudeToKiroRequest(MODEL, body, true, {});

    // tool_use stays in history.
    expect(findToolUse(out, "toolu_2t")).toBeTruthy();

    // currentMessage carries the tool_result (it was the last user turn).
    const ctx =
      out.conversationState.currentMessage.userInputMessage.userInputMessageContext;
    expect(ctx?.toolResults).toBeTruthy();
    const hit = ctx.toolResults.find((x) => x.toolUseId === "toolu_2t");
    expect(hit).toBeTruthy();
    expect(hit.content[0].text).toBe("result");
  });

  it("OpenAI-pivot multi-turn produces the same toolUseId linkage", () => {
    const body = {
      tools: [
        {
          type: "function",
          function: { name: "f", description: "x", parameters: { type: "object", properties: {} } },
        },
      ],
      messages: [
        { role: "user", content: "ask" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_mt", type: "function", function: { name: "f", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_mt", content: "answer" },
        { role: "user", content: "thanks" },
      ],
    };
    const out = buildKiroPayload(MODEL, body, true, {});

    // The toolUse references the same id as the toolResult.
    const tu = findToolUse(out, "call_mt");
    expect(tu).toBeTruthy();
    const tr = findToolResult(out, "call_mt");
    expect(tr).toBeTruthy();
    expect(tr.content[0].text).toBe("answer");
  });
});

describe("T5 / normalization parity — claude-to-kiro vs openai-to-kiro on Claude-shape input", () => {
  // Same Claude-shape input fed to both translators must produce the same
  // toolResults entry shape (modulo content text formatting). Document any
  // residual divergence in the report.
  const claudeBody = {
    tools: [TOOL_F],
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_n", name: "f", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_n",
            is_error: true,
            content: [{ type: "text", text: "err" }],
          },
        ],
      },
    ],
  };
  const openaiBody = {
    tools: [
      {
        type: "function",
        function: { name: "f", description: "x", parameters: { type: "object", properties: {} } },
      },
    ],
    messages: claudeBody.messages,
  };

  it("both paths emit status:error for is_error:true", () => {
    const a = claudeToKiroRequest(MODEL, claudeBody, true, {});
    const b = buildKiroPayload(MODEL, openaiBody, true, {});
    expect(findToolResult(a, "toolu_n").status).toBe("error");
    expect(findToolResult(b, "toolu_n").status).toBe("error");
  });

  it("both paths emit the same content text for an array-of-text tool_result", () => {
    const a = claudeToKiroRequest(MODEL, claudeBody, true, {});
    const b = buildKiroPayload(MODEL, openaiBody, true, {});
    expect(findToolResult(a, "toolu_n").content[0].text).toBe("err");
    expect(findToolResult(b, "toolu_n").content[0].text).toBe("err");
  });
});
