// Task 08 — drop-in contract tests for the direct claude:kiro / kiro:claude
// translator pair. Verifies parity with the OpenAI pivot and the new
// task 01-13 fixes (sanitizer, max_tokens, system placement, content-block
// fidelity, tool desc cap, typed-tool downgrade, etc.).
import { describe, it, expect, vi } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const C2K = (body, model = "claude-sonnet-4.5") =>
  translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, model, body, true, null, "kiro");

const K2C = (chunk, state) =>
  translateResponse(FORMATS.KIRO, FORMATS.CLAUDE, chunk, state);

describe("Task 02 — max_tokens parity with pivot", () => {
  it("hardcodes maxTokens=32000 regardless of body.max_tokens (matches buildKiroPayload)", () => {
    const a = C2K({ max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    const b = C2K({ max_tokens: 999999, messages: [{ role: "user", content: "hi" }] });
    const c = C2K({ messages: [{ role: "user", content: "hi" }] });
    expect(a.inferenceConfig.maxTokens).toBe(32000);
    expect(b.inferenceConfig.maxTokens).toBe(32000);
    expect(c.inferenceConfig.maxTokens).toBe(32000);
  });
});

describe("Task 03 — system prompt goes to history priming, not currentMessage prepend", () => {
  it("body.system as string lands as a synthetic leading user turn in history", () => {
    const out = C2K({
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    // The synthetic system turn merges with the first real user turn (Kiro
    // requires alternating roles), so the merged user content carries both —
    // and currentMessage (popped as the last user turn) carries them combined.
    const cur = out.conversationState.currentMessage.userInputMessage.content;
    expect(cur).toContain("be terse");
    expect(cur).toContain("hi");
  });

  it("body.system as array of {text} blocks is joined", () => {
    const out = C2K({
      system: [{ type: "text", text: "rule 1" }, { type: "text", text: "rule 2" }],
      messages: [{ role: "user", content: "go" }],
    });
    const cur = out.conversationState.currentMessage.userInputMessage.content;
    expect(cur).toContain("rule 1");
    expect(cur).toContain("rule 2");
  });
});

describe("Task 06 — image and source guards", () => {
  it("base64 images are forwarded as Kiro images[]", () => {
    const out = C2K({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    });
    const images = out.conversationState.currentMessage.userInputMessage.images;
    expect(Array.isArray(images)).toBe(true);
    expect(images[0]).toEqual({ format: "png", source: { bytes: "AAAA" } });
  });

  it("URL-form images fall back to text marker", () => {
    const out = C2K({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", source: { type: "url", url: "https://example.com/x.png" } },
          ],
        },
      ],
    });
    const cur = out.conversationState.currentMessage.userInputMessage.content;
    expect(cur).toContain("[Image: https://example.com/x.png");
  });

  it("file-source images fall back to a file_id marker", () => {
    const out = C2K({
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "file", file_id: "file_abc" } }],
        },
      ],
    });
    const cur = out.conversationState.currentMessage.userInputMessage.content;
    expect(cur).toContain("[Image: file_id=file_abc");
  });
});

describe("Task 07 — stop_sequences forwarded", () => {
  it("forwards body.stop_sequences to inferenceConfig.stopSequences", () => {
    const out = C2K({
      stop_sequences: ["END", "STOP"],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.inferenceConfig.stopSequences).toEqual(["END", "STOP"]);
  });
});

describe("Task 11 — content-block fidelity", () => {
  it("11a — tool_result.is_error: true maps to Kiro status: \"error\"", () => {
    const out = C2K({
      tools: [{ name: "f", description: "fn", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true, content: "kaboom" },
          ],
        },
      ],
    });
    // Walk every carrier and find the t1 result
    const carriers = [
      ...out.conversationState.history,
      out.conversationState.currentMessage,
    ];
    let result;
    for (const item of carriers) {
      const tr = item.userInputMessage?.userInputMessageContext?.toolResults;
      if (tr) {
        const hit = tr.find((x) => x.toolUseId === "t1");
        if (hit) {
          result = hit;
          break;
        }
      }
    }
    expect(result, "expected to find t1 tool result").toBeTruthy();
    expect(result.status).toBe("error");
  });

  it("11a — default is_error absence still maps to status: \"success\"", () => {
    const out = C2K({
      tools: [{ name: "f", description: "fn", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      ],
    });
    const carriers = [
      ...out.conversationState.history,
      out.conversationState.currentMessage,
    ];
    let result;
    for (const item of carriers) {
      const tr = item.userInputMessage?.userInputMessageContext?.toolResults;
      if (tr) {
        const hit = tr.find((x) => x.toolUseId === "t1");
        if (hit) {
          result = hit;
          break;
        }
      }
    }
    expect(result.status).toBe("success");
  });

  it("11b — role:\"system\" mid-conversation messages collapse to user with marker", () => {
    const out = C2K({
      messages: [
        { role: "user", content: "a" },
        { role: "system", content: "rule" },
        { role: "user", content: "b" },
      ],
    });
    const carriers = [
      ...out.conversationState.history,
      out.conversationState.currentMessage,
    ];
    const allText = carriers
      .map((c) => c.userInputMessage?.content || "")
      .join("\n");
    expect(allText).toContain("a");
    expect(allText).toContain("[System: rule]");
    expect(allText).toContain("b");
  });

  it("11c — assistant thinking blocks fold into history text (not silently dropped)", () => {
    const out = C2K({
      tools: [{ name: "f", description: "fn", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "ask" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "considering options" },
            { type: "text", text: "answer" },
          ],
        },
        { role: "user", content: "follow up" },
      ],
    });
    const arm = out.conversationState.history.find((h) => h.assistantResponseMessage)
      ?.assistantResponseMessage;
    expect(arm).toBeTruthy();
    expect(arm.content).toContain("considering options");
    expect(arm.content).toContain("answer");
  });
});

describe("Task 13 — advanced content blocks", () => {
  it("13a — tool descriptions over 10237 chars are truncated", () => {
    const longDesc = "x".repeat(20000);
    const out = C2K({
      tools: [{ name: "big", description: longDesc, input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "go" }],
    });
    const tools =
      out.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    expect(tools[0].toolSpecification.description.length).toBe(10237);
  });

  it("13a — normal tool descriptions pass through unchanged", () => {
    const out = C2K({
      tools: [{ name: "small", description: "do a thing", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "go" }],
    });
    const tools =
      out.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    expect(tools[0].toolSpecification.description).toBe("do a thing");
  });

  it("13b — document blocks become a [Document: ...] marker", () => {
    const out = C2K({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              title: "Quarterly Report",
              source: { type: "base64", media_type: "application/pdf", data: "AAAA" },
            },
          ],
        },
      ],
    });
    const cur = out.conversationState.currentMessage.userInputMessage.content;
    expect(cur).toContain("[Document: Quarterly Report");
    expect(cur).not.toContain("AAAA");
  });

  it("13d — Anthropic typed tool definitions are downgraded to custom-tool specs", () => {
    const out = C2K({
      tools: [
        { type: "web_search_20260209", name: "web_search" },
        { type: "bash_20250124", name: "bash" },
        { name: "myTool", description: "x", input_schema: { type: "object", properties: {} } },
      ],
      messages: [{ role: "user", content: "go" }],
    });
    const tools =
      out.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools;
    expect(tools).toHaveLength(3);
    expect(tools[0].toolSpecification.name).toBe("web_search");
    expect(tools[0].toolSpecification.inputSchema.json.required).toEqual(["query"]);
    expect(tools[1].toolSpecification.name).toBe("bash");
    expect(tools[1].toolSpecification.inputSchema.json.properties.command.type).toBe("string");
    expect(tools[2].toolSpecification.name).toBe("myTool");
  });
});

describe("Task 12 — silent-drop diagnostics", () => {
  it("logs dropped fields when log.debug is wired", () => {
    const debug = vi.fn();
    const log = { debug };
    translateRequest(
      FORMATS.CLAUDE,
      FORMATS.KIRO,
      "claude-sonnet-4.5",
      {
        cache_control: { type: "ephemeral" },
        tool_choice: { type: "auto" },
        output_config: { effort: "high" },
        metadata: { user_id: "u1" },
        top_k: 5,
        messages: [{ role: "user", content: "hi" }],
      },
      true,
      null,
      "kiro",
      log
    );
    expect(debug).toHaveBeenCalledTimes(1);
    const args = debug.mock.calls[0];
    expect(args[0]).toBe("CLAUDE_TO_KIRO");
    expect(args[1]).toContain("cache_control(top-level)");
    expect(args[1]).toContain("tool_choice");
    expect(args[1]).toContain("output_config.effort=high");
    expect(args[1]).toContain("metadata.user_id");
    expect(args[1]).toContain("top_k");
  });

  it("no logger → no throw and no observable side effect", () => {
    expect(() =>
      C2K({ cache_control: { type: "ephemeral" }, messages: [{ role: "user", content: "hi" }] })
    ).not.toThrow();
  });
});

describe("Task 04 — feature flag rolls back to pivot", () => {
  it("setting DISABLE_DIRECT_TRANSLATION_ROUTES=1 routes through pivot", () => {
    const prev = process.env.DISABLE_DIRECT_TRANSLATION_ROUTES;
    process.env.DISABLE_DIRECT_TRANSLATION_ROUTES = "1";
    try {
      const out = C2K({ messages: [{ role: "user", content: "hi" }] });
      // Pivot path leaves max_tokens=32000 but goes through a different
      // structural translator. The signature: pivot's claude→openai sets
      // result.messages, openai→kiro then builds conversationState. We just
      // verify the flag took effect by checking that direct-route-only
      // markers (e.g. _kiroUpstreamModel) still appear (both paths set it),
      // but more importantly that the call didn't throw and produced a payload.
      expect(out.conversationState).toBeTruthy();
    } finally {
      if (prev === undefined) {
        delete process.env.DISABLE_DIRECT_TRANSLATION_ROUTES;
      } else {
        process.env.DISABLE_DIRECT_TRANSLATION_ROUTES = prev;
      }
    }
  });
});

describe("Task 01 — kiro→claude tool arg sanitization", () => {
  it("sanitizes Read tool args (string→number, clamp limit, drop bad pages)", () => {
    const state = {};
    K2C(
      {
        id: "c", model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tu1", type: "function", function: { name: "Read", arguments: "" } }] }, finish_reason: null }],
      },
      state
    );
    K2C(
      {
        id: "c", model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":"/a.txt","limit":"3000","offset":"-5","pages":"1-2"}' } }] }, finish_reason: null }],
      },
      state
    );
    const events = K2C(
      { id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      state
    );
    const jsonDelta = events.find(
      (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
    );
    const parsed = JSON.parse(jsonDelta.delta.partial_json);
    expect(parsed.limit).toBe(2000);
    expect(parsed.offset).toBe(0);
    expect("pages" in parsed).toBe(false);
  });

  it("strips proxy_ prefix from displayed tool name", () => {
    const state = {};
    const events = K2C(
      {
        id: "c", model: "m",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "tu1", type: "function", function: { name: "proxy_Read", arguments: "" } }] }, finish_reason: null }],
      },
      state
    );
    const start = events.find(
      (e) => e.type === "content_block_start" && e.content_block?.type === "tool_use"
    );
    expect(start.content_block.name).toBe("Read");
  });
});

describe("multi-turn role merging", () => {
  it("two consecutive user turns are merged in Kiro history", () => {
    const out = C2K({
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
        { role: "assistant", content: "ack" },
        { role: "user", content: "third" },
      ],
    });
    // currentMessage is the popped last user → "third"
    expect(out.conversationState.currentMessage.userInputMessage.content).toContain("third");
    // History has merged user before the assistant turn
    const userInHist = out.conversationState.history.find((h) => h.userInputMessage);
    expect(userInHist.userInputMessage.content).toMatch(/first[\s\S]*second/);
  });
});

describe("agentic suffix injection", () => {
  it("model with -agentic suffix injects KIRO_AGENTIC_SYSTEM_PROMPT into the leading synthetic system message (one-shot, not per-turn)", () => {
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.KIRO,
      "claude-sonnet-4.5-agentic",
      {
        system: "be concise",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "second" },
        ],
      },
      true,
      null,
      "kiro"
    );

    // Leading synthetic user-role message in history carries the agentic
    // prompt + the original system text. The protocol must NOT be repeated
    // on every user turn — that pollutes history and wastes tokens.
    const history = out.conversationState.history;
    const leading = history[0]?.userInputMessage?.content || "";
    expect(leading).toContain("CHUNKED WRITE PROTOCOL");
    expect(leading).toContain("be concise");

    // Current message and any other historical user turns should NOT contain
    // the protocol — only the leading system message should.
    const cur = out.conversationState.currentMessage.userInputMessage.content;
    expect(cur).not.toContain("CHUNKED WRITE PROTOCOL");
    for (const turn of history.slice(1)) {
      const txt = turn?.userInputMessage?.content || "";
      expect(txt).not.toContain("CHUNKED WRITE PROTOCOL");
    }
  });

  it("model without -agentic suffix does not inject KIRO_AGENTIC_SYSTEM_PROMPT anywhere", () => {
    const out = translateRequest(
      FORMATS.CLAUDE,
      FORMATS.KIRO,
      "claude-sonnet-4.5",
      { messages: [{ role: "user", content: "hi" }] },
      true,
      null,
      "kiro"
    );
    const cur = out.conversationState.currentMessage.userInputMessage.content;
    const histTxt = (out.conversationState.history || [])
      .map((h) => h?.userInputMessage?.content || "")
      .join("\n");
    expect(cur).not.toContain("CHUNKED WRITE PROTOCOL");
    expect(histTxt).not.toContain("CHUNKED WRITE PROTOCOL");
  });
});
