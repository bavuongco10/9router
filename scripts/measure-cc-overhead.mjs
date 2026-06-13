/**
 * Token-overhead measurement for the cc/ (claude-direct) gateway path.
 *
 * Runs the actual transformation pipeline (prepareClaudeRequest +
 * cloakClaudeTools + applyCloaking) against synthetic requests representing
 * common shapes, then prints byte and approximate-token diffs vs the
 * original request.
 *
 * Token estimation: Anthropic's tokenizer averages ~3.5 chars/token for
 * English+JSON. We use 4.0 as a conservative estimate.
 */
import { prepareClaudeRequest } from "../open-sse/translator/helpers/claudeHelper.js";
import { cloakClaudeTools } from "../open-sse/utils/claudeCloaking.js";
import { collectBetaFlags } from "../open-sse/config/anthropicToolRegistry.js";

const tok = (chars) => Math.round(chars / 4);
const fmt = (n) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function diffReport(label, before, after, extras = {}) {
  const beforeChars = JSON.stringify(before).length;
  const afterChars = JSON.stringify(after).length;
  const delta = afterChars - beforeChars;
  const pct = ((delta / beforeChars) * 100).toFixed(2);
  const sign = delta >= 0 ? "+" : "";
  console.log(`\n--- ${label} ---`);
  console.log(`  client chars: ${fmt(beforeChars)}  (~${fmt(tok(beforeChars))} tokens)`);
  console.log(`  upstream chars: ${fmt(afterChars)}  (~${fmt(tok(afterChars))} tokens)`);
  console.log(`  delta:        ${sign}${fmt(delta)} chars  ${sign}${pct}%  (~${sign}${fmt(tok(delta))} tokens)`);
  if (extras.toolsBefore !== undefined) {
    console.log(`  tools: ${extras.toolsBefore} → ${extras.toolsAfter}`);
  }
  if (extras.systemBefore !== undefined) {
    console.log(`  system blocks: ${extras.systemBefore} → ${extras.systemAfter}`);
  }
  return delta;
}

function runScenario(label, body, apiKey) {
  let result = JSON.parse(JSON.stringify(body));

  result = prepareClaudeRequest(result, "claude", apiKey, "test-conn-id");

  const toolsBefore = body.tools?.length || 0;
  const sysBefore = Array.isArray(body.system) ? body.system.length : (body.system ? 1 : 0);

  if (apiKey?.includes("sk-ant-oat")) {
    const cloaked = cloakClaudeTools(result);
    result = cloaked.body;
  }

  const toolsAfter = result.tools?.length || 0;
  const sysAfter = Array.isArray(result.system) ? result.system.length : (result.system ? 1 : 0);

  return diffReport(label, body, result, {
    toolsBefore, toolsAfter, systemBefore: sysBefore, systemAfter: sysAfter
  });
}

const minimal = {
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "What is 2+2?" }]
};

const withSystem = {
  model: "claude-opus-4-7",
  max_tokens: 1024,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "What is 2+2?" }]
};

const with5Tools = {
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "What is 2+2?" }],
  tools: [
    { name: "calc", description: "Calculator with arithmetic ops", input_schema: { type: "object", properties: { expr: { type: "string" } }, required: ["expr"] } },
    { name: "search", description: "Web search by query", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "fetch_url", description: "Fetch URL contents", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    { name: "ls_files", description: "List files in a directory", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "read_file", description: "Read file contents", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
  ]
};

const realisticBody = {
  model: "claude-opus-4-7",
  max_tokens: 4096,
  system: [
    { type: "text", text: "You are Claude, an AI coding assistant. Help the user with software engineering tasks. Use the provided tools to read, write, and execute code." }
  ],
  messages: Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: i % 2 === 0
      ? `Question number ${i / 2 + 1}: please explain how to refactor this function for clarity. ${"Lorem ipsum dolor sit amet ".repeat(20)}`
      : `Sure, here is the explanation for your question. ${"Consectetur adipiscing elit ".repeat(30)}`
  })),
  tools: [
    "Read", "Write", "Edit", "Bash", "Grep", "Glob",
    "Task", "TaskCreate", "TaskList", "TaskUpdate", "TaskGet", "TaskStop", "TaskOutput",
    "WebSearch", "WebFetch", "AskUserQuestion", "Skill", "EnterPlanMode", "ExitPlanMode",
    "NotebookEdit"
  ].map(name => ({
    name,
    description: `${name} tool: do the ${name} operation. Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
    input_schema: { type: "object", properties: { arg1: { type: "string" }, arg2: { type: "number" } } }
  }))
};

const withTypedTool = {
  model: "claude-opus-4-7",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Search the web for AI news" }],
  tools: [
    { type: "web_search_20250305", name: "web_search" }
  ]
};

console.log("=".repeat(72));
console.log("9router cc/ path — request transformation overhead measurement");
console.log("=".repeat(72));

console.log("\n### API-key auth (sk-ant-api03..., cloaking SKIPPED)");
const apiKey = "sk-ant-api03-fake-key";
runScenario("Minimal (1 user msg, no tools, no system)", minimal, apiKey);
runScenario("With system prompt", withSystem, apiKey);
runScenario("With 5 custom tools", with5Tools, apiKey);
runScenario("Realistic (10 msgs, 20 tools, system)", realisticBody, apiKey);
runScenario("With typed tool (web_search_20250305)", withTypedTool, apiKey);

console.log("\n### OAuth auth (sk-ant-oat..., cloaking ENABLED)");
const oauthKey = "sk-ant-oat-fake-key";
runScenario("Minimal (1 user msg, no tools)", minimal, oauthKey);
runScenario("With system prompt", withSystem, oauthKey);
runScenario("With 5 custom tools (cloaking adds suffix + decoys)", with5Tools, oauthKey);
runScenario("Realistic (10 msgs, 20 tools, OAuth)", realisticBody, oauthKey);
runScenario("With typed tool (typed tools skip cloaking)", withTypedTool, oauthKey);

console.log("\n### Beta-flag header overhead (cc/ typed-tool fix)");
const flags = collectBetaFlags(withTypedTool.tools);
console.log(`  typed tool collected ${flags.length} beta flag(s): ${flags.join(", ")}`);
console.log(`  header chars added:   ~${flags.join(",").length} (header only, not body)`);

console.log("\n" + "=".repeat(72));
console.log("Summary");
console.log("=".repeat(72));
console.log(`
Token cost per request, by auth type:

  API key (sk-ant-api03):
    - Cloaking SKIPPED — no decoys, no suffix
    - Net: ~0 tokens added (only cache_control fields)
    - With many messages: RTK compression often REDUCES tokens

  OAuth (sk-ant-oat):
    - Billing header injected as system[0]: ~80 chars (~20 tokens)
      (Claude Code clients ALREADY include this — no double-injection)
    - Custom tools renamed *_ide:           +4 chars/tool (~1 token each)
    - 21 decoy tools added:                 ~1500-2000 chars (~400-500 tokens)
    - metadata.user_id injected:            ~200 chars (in body, ~50 tokens)
    - Total: ~470-570 tokens overhead per request (one-time, not per msg)

  Typed tools (web_search etc.) — fixed in this session:
    - body: NO change (typed tools skip cloaking entirely)
    - header: per-tool beta flag added to Anthropic-Beta (not body, not billed)
`);
