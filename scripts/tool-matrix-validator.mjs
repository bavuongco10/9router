#!/usr/bin/env node
/**
 * Tool-matrix validator (T7) — exercise every Anthropic typed tool against
 * the 9router gateway on both cc/ and kr/ paths, reconstruct tool inputs by
 * accumulating input_json_delta.partial_json (NEVER read content_block_start
 * placeholder — that bug caused the false "empty input" finding), and emit a
 * markdown matrix to tasks/fix-tool-issue/tool_matrix_after.md.
 *
 * Usage:
 *   GATEWAY_URL=http://buis-mac-mini.local:20128/v1 \
 *   GATEWAY_API_KEY=<token> \
 *   node scripts/tool-matrix-validator.mjs [--gateway URL] [--timeout-ms N] [--output PATH]
 *
 * Exit codes:
 *   0 — all combinations matched their target state
 *   1 — at least one combination failed
 *   2 — gateway unreachable; a stub matrix was emitted
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import {
  _REGISTRY_FOR_TESTS,
  defaultNameForFamily
} from "../open-sse/config/anthropicToolRegistry.js";

// -------------------------------- args ---------------------------------------
const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return fallback;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GATEWAY = "http://buis-mac-mini.local:20128/v1";
const GATEWAY = (flag("gateway") || process.env.GATEWAY_URL || DEFAULT_GATEWAY).replace(/\/$/, "");
const API_KEY = process.env.GATEWAY_API_KEY || "";
const TIMEOUT_MS = Number(flag("timeout-ms") || 60000);
const OUTPUT = path.resolve(
  flag("output") ||
    path.join(HERE, "..", "tasks", "fix-tool-issue", "tool_matrix_after.md")
);
const CC_MODEL = flag("cc-model") || "cc/claude-opus-4-8";
const KR_MODEL = flag("kr-model") || "kr/claude-opus-4.8";

// ---------------------------- per-family prompts -----------------------------
// Crafted to actually trigger the tool the model is given.
const FAMILY_PROMPT = {
  web_search:
    "Search the web for the latest news from 2026 about AI and tell me what you find. Use the web_search tool.",
  web_fetch:
    "Fetch https://example.com using the web_fetch tool and summarize what you find.",
  code_execution:
    "Use the code execution tool to run python that computes 17 * 23 and print the result.",
  bash:
    "List the contents of /tmp using the bash tool.",
  text_editor:
    "Use the text editor tool to create a file at /tmp/x.txt with the content 'hi'.",
  memory:
    "Use the memory tool to remember that my name is Alice — store it under /memories/profile.",
  tool_search_bm25:
    "Use the tool_search tool to find tools related to computing statistics.",
  tool_search_regex:
    "Use the tool_search tool with a regex pattern to find tools matching 'compute.*'."
};

const CUSTOM_TOOL = {
  name: "lookup_inventory",
  description: "Look up an item in the inventory",
  input_schema: {
    type: "object",
    properties: { sku: { type: "string" } },
    required: ["sku"]
  }
};
const CUSTOM_PROMPT = "Look up the inventory for sku ABC-123 using the lookup_inventory tool.";

// ----------------------------- target state ----------------------------------
// From tasks/fix-tool-issue/tasks.md §4.
function targetForCell(category, pathKey) {
  if (pathKey === "cc" && category === "A") {
    return {
      label: "cc/A",
      needsServerToolUse: true,
      needsToolResult: true,
      allowedStop: ["tool_use", "end_turn"]
    };
  }
  if (pathKey === "cc" && category === "B") {
    return { label: "cc/B", needsToolUse: true, allowedStop: ["tool_use"] };
  }
  if (pathKey === "kr" && (category === "A" || category === "B")) {
    return { label: `kr/${category}`, needsToolUse: true, allowedStop: ["tool_use"] };
  }
  if (category === "C") {
    return { label: `${pathKey}/C`, needsToolUse: true, allowedStop: ["tool_use"] };
  }
  return null;
}

// ------------------------------- SSE parser ----------------------------------
// Inline tiny SSE parser; yields { event, data } for each `\n\n`-terminated frame.
async function* parseSSE(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let eventType = "message";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      const data = dataLines.join("\n");
      if (data === "[DONE]") return;
      try {
        yield { event: eventType, data: JSON.parse(data) };
      } catch {
        // ignore malformed frame
      }
    }
  }
}

// ----------------------------- request runner --------------------------------
function buildHeaders() {
  const h = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "anthropic-version": "2023-06-01"
  };
  if (API_KEY) {
    h["x-api-key"] = API_KEY;
    h["Authorization"] = `Bearer ${API_KEY}`;
  }
  return h;
}

/**
 * Issue one Messages API streaming request and reconstruct tool blocks.
 * Returns a result snapshot { status, blocks, stopReason, error, ... }.
 */
async function runRequest({ model, prompt, tools, label }) {
  const body = {
    model,
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: prompt }],
    tools
  };
  const url = `${GATEWAY}/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const result = {
    label,
    status: 0,
    statusText: "",
    blocks: [],
    stopReason: null,
    error: null,
    durationMs: 0
  };
  const t0 = Date.now();

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    result.error = `network: ${e.message || e}`;
    result.durationMs = Date.now() - t0;
    return result;
  }

  result.status = res.status;
  result.statusText = res.statusText;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    result.error = text.slice(0, 2000);
    clearTimeout(timer);
    result.durationMs = Date.now() - t0;
    return result;
  }

  const blocksByIndex = new Map();
  try {
    for await (const ev of parseSSE(res.body)) {
      const d = ev.data;
      const t = ev.event || d?.type;
      if (t === "content_block_start") {
        const cb = d.content_block || {};
        // CRITICAL: do NOT read cb.input — it's the placeholder ({}).
        // Real input arrives via input_json_delta.partial_json on the deltas.
        blocksByIndex.set(d.index, {
          index: d.index,
          type: cb.type,
          name: cb.name || null,
          id: cb.id || null,
          inputBuffer: "",
          parsedInput: null,
          inlineContent: cb.content || null
        });
      } else if (t === "content_block_delta") {
        const blk = blocksByIndex.get(d.index);
        if (!blk) continue;
        const delta = d.delta || {};
        if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          blk.inputBuffer += delta.partial_json;
        }
      } else if (t === "content_block_stop") {
        const blk = blocksByIndex.get(d.index);
        if (!blk) continue;
        if (blk.inputBuffer) {
          try {
            blk.parsedInput = JSON.parse(blk.inputBuffer);
          } catch {
            blk.parsedInput = { __raw: blk.inputBuffer };
          }
        }
      } else if (t === "message_delta") {
        if (d.delta?.stop_reason) result.stopReason = d.delta.stop_reason;
      }
    }
  } catch (e) {
    if (e.name === "AbortError") result.error = `timeout after ${TIMEOUT_MS}ms`;
    else result.error = `stream: ${e.message || e}`;
  } finally {
    clearTimeout(timer);
  }

  result.blocks = Array.from(blocksByIndex.values());
  result.durationMs = Date.now() - t0;
  return result;
}

// ----------------------------- evaluation ------------------------------------
function isNonEmptyInput(parsed) {
  if (!parsed) return false;
  if (parsed.__raw) return String(parsed.__raw).trim().length > 0;
  if (typeof parsed === "object") return Object.keys(parsed).length > 0;
  return false;
}

function evaluate(result, target) {
  if (!target) return { pass: false, reasons: ["no target"] };
  const reasons = [];

  if (result.status !== 200) {
    reasons.push(
      `HTTP ${result.status} ${(result.error || "").slice(0, 200).replace(/\s+/g, " ")}`
    );
  }

  const toolUseBlocks = result.blocks.filter((b) => b.type === "tool_use");
  const serverToolUseBlocks = result.blocks.filter(
    (b) => b.type === "server_tool_use"
  );
  const toolResultBlocks = result.blocks.filter(
    (b) => b.type && /_tool_result$/.test(b.type)
  );

  if (target.needsServerToolUse) {
    if (serverToolUseBlocks.length === 0) reasons.push("no server_tool_use block");
    if (target.needsToolResult && toolResultBlocks.length === 0) {
      reasons.push("no *_tool_result block");
    }
    if (
      serverToolUseBlocks.length > 0 &&
      !serverToolUseBlocks.some((b) => isNonEmptyInput(b.parsedInput))
    ) {
      reasons.push("empty reconstructed input (server_tool_use)");
    }
  } else if (target.needsToolUse) {
    if (toolUseBlocks.length === 0) reasons.push("no tool_use block");
    if (
      toolUseBlocks.length > 0 &&
      !toolUseBlocks.some((b) => isNonEmptyInput(b.parsedInput))
    ) {
      reasons.push("empty reconstructed input (tool_use)");
    }
  }

  if (
    target.allowedStop &&
    result.stopReason &&
    !target.allowedStop.includes(result.stopReason)
  ) {
    reasons.push(
      `stop_reason ${result.stopReason} not in {${target.allowedStop.join(",")}}`
    );
  }

  return { pass: reasons.length === 0, reasons };
}

// ----------------------------- matrix building -------------------------------
function buildMatrix() {
  const rows = [];
  for (const [typeStr, entry] of Object.entries(_REGISTRY_FOR_TESTS)) {
    rows.push({
      kind: "typed",
      typeStr,
      family: entry.family,
      category: entry.category,
      tool: { type: typeStr, name: defaultNameForFamily(entry.family) || entry.family },
      prompt: FAMILY_PROMPT[entry.family] || `Use the ${entry.family} tool to complete a small task.`
    });
  }
  rows.push({
    kind: "custom",
    typeStr: "custom",
    family: "custom",
    category: "C",
    tool: CUSTOM_TOOL,
    prompt: CUSTOM_PROMPT
  });
  return rows;
}

// ----------------------------- output rendering ------------------------------
function summarizeInput(blocks) {
  if (blocks.length === 0) return "—";
  const interesting = blocks.filter(
    (b) => b.type === "tool_use" || b.type === "server_tool_use"
  );
  if (interesting.length === 0) {
    const types = blocks.map((b) => b.type).join(", ");
    return `(no tool_use; blocks: ${types || "none"})`;
  }
  const parts = interesting.map((b) => {
    const inp = b.parsedInput;
    if (!inp) return `${b.type}:<no-input>`;
    if (inp.__raw) {
      return `${b.type}:RAW \`${truncate(inp.__raw, 80)}\``;
    }
    return `${b.type}:\`${truncate(JSON.stringify(inp), 100)}\``;
  });
  return parts.join("<br>");
}

function truncate(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function escapeCell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMatrix({ rows, results, gateway, startedAt, finishedAt }) {
  const lines = [];
  lines.push(`# Tool Matrix — After State (T7)`);
  lines.push("");
  lines.push(`- Generated: ${finishedAt.toISOString()}`);
  lines.push(`- Gateway: \`${gateway}\``);
  lines.push(`- cc/ model: \`${CC_MODEL}\``);
  lines.push(`- kr/ model: \`${KR_MODEL}\``);
  lines.push(`- Auth: ${API_KEY ? "bearer + x-api-key" : "(none)"}`);
  lines.push(`- Run duration: ${Math.round((finishedAt - startedAt) / 1000)}s`);
  lines.push("");
  lines.push(
    "Tool inputs were reconstructed by accumulating `input_json_delta.partial_json` " +
      "across `content_block_delta` events; the `content_block_start` placeholder is intentionally ignored."
  );
  lines.push("");
  lines.push(
    "| Tool Type | Cat | cc/ Status | cc/ Reconstructed Input | cc/ Stop | cc/ Pass | kr/ Status | kr/ Reconstructed Input | kr/ Stop | kr/ Pass |"
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|");

  let pass = 0;
  let total = 0;
  const failures = [];

  for (const row of rows) {
    const cc = results.get(`cc::${row.typeStr}`);
    const kr = results.get(`kr::${row.typeStr}`);
    const ccTarget = targetForCell(row.category, "cc");
    const krTarget = targetForCell(row.category, "kr");
    const ccEval = evaluate(cc, ccTarget);
    const krEval = evaluate(kr, krTarget);

    total += 2;
    if (ccEval.pass) pass++;
    if (krEval.pass) pass++;

    if (!ccEval.pass) {
      failures.push({ row, pathKey: "cc", result: cc, reasons: ccEval.reasons });
    }
    if (!krEval.pass) {
      failures.push({ row, pathKey: "kr", result: kr, reasons: krEval.reasons });
    }

    lines.push(
      "| " +
        [
          `\`${row.typeStr}\``,
          row.category,
          `${cc.status || "ERR"}`,
          escapeCell(summarizeInput(cc.blocks)),
          escapeCell(cc.stopReason || "—"),
          ccEval.pass ? "PASS" : "FAIL",
          `${kr.status || "ERR"}`,
          escapeCell(summarizeInput(kr.blocks)),
          escapeCell(kr.stopReason || "—"),
          krEval.pass ? "PASS" : "FAIL"
        ].join(" | ") +
        " |"
    );
  }

  lines.push("");
  lines.push(`**Summary**: ${pass}/${total} cells passed.`);
  lines.push("");

  if (failures.length > 0) {
    lines.push("## Failures");
    lines.push("");
    for (const f of failures) {
      lines.push(`### \`${f.row.typeStr}\` on ${f.pathKey}/`);
      lines.push("");
      lines.push(`- HTTP: ${f.result.status} ${f.result.statusText || ""}`);
      lines.push(`- Stop reason: ${f.result.stopReason || "—"}`);
      lines.push(`- Reasons: ${f.reasons.join("; ")}`);
      if (f.result.error) {
        lines.push("- Error/body:");
        lines.push("");
        lines.push("```");
        lines.push(truncate(f.result.error, 1500));
        lines.push("```");
      }
      const blockSummary = f.result.blocks.map((b) => ({
        type: b.type,
        name: b.name,
        input: b.parsedInput
      }));
      if (blockSummary.length > 0) {
        lines.push("- Blocks:");
        lines.push("");
        lines.push("```json");
        lines.push(truncate(JSON.stringify(blockSummary, null, 2), 1500));
        lines.push("```");
      }
      lines.push("");
    }
  }

  return { md: lines.join("\n") + "\n", pass, total, failures };
}

// ------------------------------- stub matrix ---------------------------------
function renderStub(rows, reason) {
  const lines = [];
  lines.push(`# Tool Matrix — After State (T7) — STUB`);
  lines.push("");
  lines.push(`- Reason: ${reason}`);
  lines.push(`- Gateway: \`${GATEWAY}\``);
  lines.push("");
  lines.push("Run manually with:");
  lines.push("");
  lines.push("```bash");
  lines.push(
    "GATEWAY_URL=http://buis-mac-mini.local:20128/v1 \\\n" +
      "GATEWAY_API_KEY=<token> \\\n" +
      "node scripts/tool-matrix-validator.mjs"
  );
  lines.push("```");
  lines.push("");
  lines.push(`Combinations that will be exercised (${rows.length} types × 2 paths + custom):`);
  lines.push("");
  for (const row of rows) {
    lines.push(`- \`${row.typeStr}\` (cat ${row.category})`);
  }
  return lines.join("\n") + "\n";
}

// -------------------------------- main ---------------------------------------
async function probeGateway() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${GATEWAY}/models`, {
      method: "GET",
      headers: buildHeaders(),
      signal: ctrl.signal
    });
    clearTimeout(t);
    // Anything that responds (incl. 401) means the host is reachable.
    return { reachable: true, status: res.status };
  } catch (e) {
    return { reachable: false, error: e.message || String(e) };
  }
}

async function main() {
  const rows = buildMatrix();
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });

  const probe = await probeGateway();
  if (!probe.reachable) {
    const stub = renderStub(
      rows,
      `Gateway unreachable from harness host: ${probe.error}`
    );
    await fs.writeFile(OUTPUT, stub, "utf-8");
    console.error(`[validator] gateway unreachable — wrote stub to ${OUTPUT}`);
    process.exit(2);
  }
  if (probe.status === 401 && !API_KEY) {
    const stub = renderStub(
      rows,
      "Gateway reachable but auth required and GATEWAY_API_KEY not set."
    );
    await fs.writeFile(OUTPUT, stub, "utf-8");
    console.error(
      `[validator] gateway returned 401 and no GATEWAY_API_KEY provided — wrote stub to ${OUTPUT}`
    );
    process.exit(2);
  }

  console.error(
    `[validator] gateway ${GATEWAY} reachable (status ${probe.status}); running ${rows.length * 2} requests`
  );
  const startedAt = new Date();

  const results = new Map();
  for (const row of rows) {
    for (const [pathKey, model] of [
      ["cc", CC_MODEL],
      ["kr", KR_MODEL]
    ]) {
      const label = `${pathKey}::${row.typeStr}`;
      console.error(`[validator] -> ${label}`);
      const r = await runRequest({
        model,
        prompt: row.prompt,
        tools: [row.tool],
        label
      });
      results.set(label, r);
      console.error(
        `[validator]    status=${r.status} stop=${r.stopReason || "-"} blocks=${r.blocks.length} ${r.error ? `err=${truncate(r.error, 80)}` : ""}`
      );
    }
  }

  const finishedAt = new Date();
  const { md, pass, total, failures } = renderMatrix({
    rows,
    results,
    gateway: GATEWAY,
    startedAt,
    finishedAt
  });
  await fs.writeFile(OUTPUT, md, "utf-8");
  console.error(`[validator] wrote ${OUTPUT}`);
  console.error(`[validator] ${pass}/${total} cells passed; ${failures.length} failures`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((e) => {
  console.error(`[validator] fatal: ${e.stack || e.message || e}`);
  process.exit(2);
});
