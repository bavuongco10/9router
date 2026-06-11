// Real-server integration tests — Claude → Kiro direct route, end-to-end.
//
// These tests hit a running 9router-development instance and validate the
// whole stack: Next.js rewrite → auth → provider routing → KiroExecutor → the
// new direct claude→kiro request and kiro→claude response translators.
//
// Opt-in via env vars so unit runs and CI never burn Kiro quota:
//   TEST_9ROUTER_URL   — http://localhost:3000
//   TEST_9ROUTER_API_KEY — 9router API key
//   TEST_9ROUTER_MODEL — defaults to "kr/auto" (Kiro-routed)
//
// Without TEST_9ROUTER_URL + TEST_9ROUTER_API_KEY the suite skips cleanly.
import { describe, it, expect, beforeAll } from "vitest";

const URL = process.env.TEST_9ROUTER_URL;
const KEY = process.env.TEST_9ROUTER_API_KEY;
const MODEL = process.env.TEST_9ROUTER_MODEL || "kr/auto";

const skip = !URL || !KEY;
const d = skip ? describe.skip : describe;

const post = (body, { stream = false } = {}) =>
  fetch(`${URL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(stream ? { accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify({ model: MODEL, ...body, ...(stream ? { stream: true } : {}) }),
  });

async function readSSEEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!data) continue;
      const json = data.slice(5).trim();
      if (json === "[DONE]") return events;
      try {
        events.push(JSON.parse(json));
      } catch {
        /* keepalive comment frame */
      }
    }
  }
  return events;
}

d("9router /v1/messages — Claude → Kiro direct route (live)", () => {
  beforeAll(() => {
    if (skip) {
      console.warn(
        "Skipping live tests — set TEST_9ROUTER_URL + TEST_9ROUTER_API_KEY to run them."
      );
    }
  });

  it("non-streaming text request returns a Claude message", async () => {
    const res = await post({
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with just the word OK" }],
    });
    const text = await res.text();
    // Some 9router setups force-stream upstream; if so the body is SSE — parse it.
    let body;
    if (text.startsWith("event:") || text.startsWith("data:")) {
      // Simulate a Response object for our reader
      const stream = new Response(text).body;
      const events = await readSSEEvents({ body: stream });
      // Reconstruct a Claude message-like shape from events for assertion.
      const msgStart = events.find((e) => e.type === "message_start");
      const textBlocks = events
        .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
        .map((e) => e.delta.text)
        .join("");
      const msgDelta = events.find((e) => e.type === "message_delta");
      body = {
        type: "message",
        role: msgStart?.message?.role,
        content: [{ type: "text", text: textBlocks }],
        stop_reason: msgDelta?.delta?.stop_reason,
      };
    } else {
      body = JSON.parse(text);
    }
    expect(res.status, text.slice(0, 500)).toBe(200);
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content.find((b) => b.type === "text")?.text).toMatch(/OK/i);
    expect(["end_turn", "stop_sequence", "max_tokens"]).toContain(body.stop_reason);
  }, 60_000);

  it("streaming text request emits a well-formed Claude SSE sequence", async () => {
    const res = await post(
      {
        max_tokens: 64,
        messages: [{ role: "user", content: "Count from 1 to 3, one number per line" }],
      },
      { stream: true }
    );
    expect(res.status).toBe(200);
    const events = await readSSEEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types).toContain("content_block_delta");
    expect(types).toContain("content_block_stop");
    expect(types).toContain("message_delta");
    expect(types[types.length - 1]).toBe("message_stop");
    const md = events.find((e) => e.type === "message_delta");
    expect(md.delta.stop_reason).toBeTruthy();
    expect(md.usage).toBeDefined();
    // Task 12 — usage block always carries cache_* keys (zero or real)
    expect(md.usage).toHaveProperty("cache_creation_input_tokens");
    expect(md.usage).toHaveProperty("cache_read_input_tokens");
  }, 90_000);

  it("guard 1: client omits `tools` on a turn carrying a stale tool_result — no 400", async () => {
    const res = await post({
      max_tokens: 32,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "f", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }],
        },
        { role: "user", content: "say OK and stop" },
      ],
    });
    const body = await res.text();
    expect(res.status, body.slice(0, 500)).not.toBe(400);
    expect(res.status).toBe(200);
  }, 60_000);

  it("guard 2: tool_result with an orphaned tool_use_id — no 400", async () => {
    const res = await post({
      max_tokens: 32,
      tools: [
        {
          name: "f",
          description: "fn",
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [
        { role: "user", content: "go" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "ghost", content: "salvage me" },
          ],
        },
        { role: "user", content: "say OK and stop" },
      ],
    });
    const body = await res.text();
    expect(res.status, body.slice(0, 500)).not.toBe(400);
    expect(res.status).toBe(200);
  }, 60_000);

  it("agentic suffix: model receives the injected KIRO_AGENTIC_SYSTEM_PROMPT", async () => {
    // Use a -agentic Kiro alias. The translator path injects
    // KIRO_AGENTIC_SYSTEM_PROMPT (open-sse/config/kiroConstants.js) into the
    // Kiro upstream payload. That prompt hardcodes "MAXIMUM 350 LINES per
    // single write/edit operation" — a number the model has no other way to
    // know. If we ask for that number and get it back, the prompt was injected
    // upstream successfully through the direct claude→kiro route.
    const agenticModel = process.env.TEST_9ROUTER_AGENTIC_MODEL || "kr/claude-sonnet-4.6-agentic";
    const res = await fetch(`${URL}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: agenticModel,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content:
              "According to your operational instructions, what is the absolute maximum number of lines per single write operation? Reply with ONLY the number, no other words.",
          },
        ],
      }),
    });
    const raw = await res.text();
    expect(res.status, raw.slice(0, 500)).toBe(200);
    let body;
    if (raw.startsWith("event:") || raw.startsWith("data:")) {
      const events = await readSSEEvents({ body: new Response(raw).body });
      const replyText = events
        .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
        .map((e) => e.delta.text)
        .join("");
      body = { content: [{ type: "text", text: replyText }] };
    } else {
      body = JSON.parse(raw);
    }
    const reply = body.content.find((b) => b.type === "text")?.text || "";
    expect(
      reply,
      `agentic model reply did not contain "350" — prompt may not have been injected: ${reply.slice(
        0,
        200
      )}`
    ).toMatch(/350/);
  }, 60_000);

  it("tool round-trip: model chooses a tool, we return a result, model finishes", async () => {
    const tools = [
      {
        name: "get_weather",
        description: "Get the current weather in a city.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const r1 = await post({
      max_tokens: 256,
      tools,
      messages: [
        { role: "user", content: "What's the weather in Paris? Use the tool." },
      ],
    });
    expect(r1.status).toBe(200);
    const text1 = await r1.text();
    let m1;
    if (text1.startsWith("event:") || text1.startsWith("data:")) {
      const events = await readSSEEvents({ body: new Response(text1).body });
      const content = [];
      // Reassemble tool_use blocks from streaming events
      const blockStarts = events.filter((e) => e.type === "content_block_start");
      const jsonDeltas = events.filter(
        (e) => e.type === "content_block_delta" && e.delta?.type === "input_json_delta"
      );
      const textDeltas = events.filter(
        (e) => e.type === "content_block_delta" && e.delta?.type === "text_delta"
      );
      for (const bs of blockStarts) {
        if (bs.content_block.type === "tool_use") {
          const inputJson = jsonDeltas
            .filter((d) => d.index === bs.index)
            .map((d) => d.delta.partial_json)
            .join("");
          let parsed = {};
          try {
            parsed = JSON.parse(inputJson || "{}");
          } catch {
            /* leave empty */
          }
          content.push({
            type: "tool_use",
            id: bs.content_block.id,
            name: bs.content_block.name,
            input: parsed,
          });
        } else if (bs.content_block.type === "text") {
          const t = textDeltas
            .filter((d) => d.index === bs.index)
            .map((d) => d.delta.text)
            .join("");
          if (t) content.push({ type: "text", text: t });
        }
      }
      m1 = { content };
    } else {
      m1 = JSON.parse(text1);
    }

    const toolUse = m1.content.find((b) => b.type === "tool_use");
    expect(
      toolUse,
      "model did not call the tool — try a more directive prompt or a different model"
    ).toBeTruthy();
    expect(toolUse.name).toBe("get_weather");
    expect(typeof toolUse.input).toBe("object");

    const r2 = await post({
      max_tokens: 128,
      tools,
      messages: [
        {
          role: "user",
          content: "What's the weather in Paris? Use the tool.",
        },
        { role: "assistant", content: m1.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: "Sunny, 18°C",
            },
          ],
        },
      ],
    });
    expect(r2.status).toBe(200);
    const text2 = await r2.text();
    let m2;
    if (text2.startsWith("event:") || text2.startsWith("data:")) {
      const events = await readSSEEvents({ body: new Response(text2).body });
      const text = events
        .filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta")
        .map((e) => e.delta.text)
        .join("");
      const md = events.find((e) => e.type === "message_delta");
      m2 = {
        content: [{ type: "text", text }],
        stop_reason: md?.delta?.stop_reason,
      };
    } else {
      m2 = JSON.parse(text2);
    }
    const text = m2.content.find((b) => b.type === "text")?.text || "";
    expect(text).toMatch(/sunny|18|paris/i);
    expect(["end_turn", "tool_use", "max_tokens"]).toContain(m2.stop_reason);
  }, 120_000);
});
