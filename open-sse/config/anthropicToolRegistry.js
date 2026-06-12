/**
 * Anthropic typed-tool registry.
 *
 * Anthropic's Messages API accepts two shapes of `tools[]` entries:
 *   - Custom: { name, description, input_schema }       — category C, the baseline.
 *   - Typed:  { type: "<family>_<YYYYMMDD>", name }     — categories A and B,
 *             schema and (sometimes) execution are predefined by Anthropic.
 *
 * The 9router gateway needs three things from any typed tool:
 *   1. Its CATEGORY — server-executed (A), client-executed built-in (B), or
 *      custom (C). Determines whether the tool round-trips entirely on
 *      Anthropic's side, or whether the client must execute and feed
 *      `tool_result` back.
 *   2. A canonical INPUT_SCHEMA — for downgrading a typed tool to a custom
 *      tool when forwarding to a backend that doesn't natively support typed
 *      tools (e.g. Kiro/CodeWhisperer).
 *   3. The ANTHROPIC-BETA flag(s) the upstream Messages API requires to
 *      accept that exact `type` string. Most typed tools require an explicit
 *      beta header — without it Anthropic returns a 400 invalid_request.
 *
 * This module is the single source of truth for that data.
 */

// Canonical input schemas. These mirror what Anthropic's docs describe for
// each tool family — used both as the kr/ downgrade schema and as the value
// the client should validate emitted tool_use input against.
const SCHEMA_BASH = {
  type: "object",
  properties: {
    command: { type: "string", description: "The bash command to run." },
    restart: { type: "boolean", description: "Set to true to restart the bash tool." }
  },
  required: []
};

// text_editor schema is shared across versions; the 20250728 variant adds
// undo_edit support but the input shape is unchanged at the schema level.
const SCHEMA_TEXT_EDITOR = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert", "undo_edit"],
      description: "The text_editor command to run."
    },
    path: { type: "string", description: "Absolute path to the file or directory." },
    file_text: { type: "string", description: "Content for create." },
    view_range: {
      type: "array",
      items: { type: "integer" },
      description: "Optional [start, end] line range for view (1-indexed)."
    },
    old_str: { type: "string", description: "String to replace (str_replace)." },
    new_str: { type: "string", description: "Replacement string (str_replace/insert)." },
    insert_line: { type: "integer", description: "Line number to insert after (insert)." }
  },
  required: ["command", "path"]
};

const SCHEMA_MEMORY = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert", "delete", "rename"],
      description: "Memory command to run."
    },
    path: { type: "string", description: "Path inside the /memories tree." },
    file_text: { type: "string" },
    view_range: { type: "array", items: { type: "integer" } },
    old_str: { type: "string" },
    new_str: { type: "string" },
    insert_line: { type: "integer" },
    new_path: { type: "string" }
  },
  required: ["command", "path"]
};

const SCHEMA_WEB_SEARCH = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query." },
    allowed_domains: { type: "array", items: { type: "string" } },
    blocked_domains: { type: "array", items: { type: "string" } },
    max_uses: { type: "integer" },
    user_location: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["approximate"] },
        city: { type: "string" },
        region: { type: "string" },
        country: { type: "string" },
        timezone: { type: "string" }
      }
    }
  },
  required: ["query"]
};

const SCHEMA_WEB_FETCH = {
  type: "object",
  properties: {
    url: { type: "string", description: "The URL to fetch." },
    max_uses: { type: "integer" },
    allowed_domains: { type: "array", items: { type: "string" } },
    blocked_domains: { type: "array", items: { type: "string" } }
  },
  required: ["url"]
};

const SCHEMA_CODE_EXECUTION = {
  type: "object",
  properties: {
    code: { type: "string", description: "Python code to execute in the sandbox." }
  },
  required: ["code"]
};

const SCHEMA_TOOL_SEARCH_BM25 = {
  type: "object",
  properties: {
    query: { type: "string", description: "BM25 query for matching tools." },
    max_results: { type: "integer" }
  },
  required: ["query"]
};

const SCHEMA_TOOL_SEARCH_REGEX = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regex pattern to match tool names." },
    max_results: { type: "integer" }
  },
  required: ["pattern"]
};

// Categories:
//   A = server-executed by Anthropic (server_tool_use + *_tool_result inline)
//   B = client-executed built-in (Anthropic-defined schema, client runs it)
//   C = custom
//
// `betas` lists the Anthropic-Beta header flags required to send that type
// to the upstream Messages API. cc/ path merges these into the outbound
// Anthropic-Beta header alongside the static CLI flags.
//
// `kiroNative` is true for tools where the kr/ path can map to a Kiro built-in
// (none today — Kiro's CLI built-ins aren't exposed in the GenerateAssistantResponse
// wire API the kr/ path translates). Reserved for future native mapping.
const REGISTRY = Object.freeze({
  // Category A — server-executed
  web_search_20250305: {
    family: "web_search", category: "A", inputSchema: SCHEMA_WEB_SEARCH,
    betas: ["web-search-2025-03-05"], kiroNative: false
  },
  web_search_20260209: {
    family: "web_search", category: "A", inputSchema: SCHEMA_WEB_SEARCH,
    betas: ["web-search-2026-02-09"], kiroNative: false
  },
  web_fetch_20250910: {
    family: "web_fetch", category: "A", inputSchema: SCHEMA_WEB_FETCH,
    betas: ["web-fetch-2025-09-10"], kiroNative: false
  },
  web_fetch_20260209: {
    family: "web_fetch", category: "A", inputSchema: SCHEMA_WEB_FETCH,
    betas: ["web-fetch-2026-02-09"], kiroNative: false
  },
  web_fetch_20260309: {
    family: "web_fetch", category: "A", inputSchema: SCHEMA_WEB_FETCH,
    betas: ["web-fetch-2026-03-09"], kiroNative: false
  },
  code_execution_20250522: {
    family: "code_execution", category: "A", inputSchema: SCHEMA_CODE_EXECUTION,
    betas: ["code-execution-2025-05-22"], kiroNative: false
  },
  code_execution_20250825: {
    family: "code_execution", category: "A", inputSchema: SCHEMA_CODE_EXECUTION,
    betas: ["code-execution-2025-08-25"], kiroNative: false
  },
  code_execution_20260120: {
    family: "code_execution", category: "A", inputSchema: SCHEMA_CODE_EXECUTION,
    betas: ["code-execution-2026-01-20"], kiroNative: false
  },

  // Category B — client-executed built-ins
  bash_20250124: {
    family: "bash", category: "B", inputSchema: SCHEMA_BASH,
    betas: ["computer-use-2025-01-24"], kiroNative: false
  },
  text_editor_20250124: {
    family: "text_editor", category: "B", inputSchema: SCHEMA_TEXT_EDITOR,
    betas: ["computer-use-2025-01-24"], kiroNative: false
  },
  text_editor_20250429: {
    family: "text_editor", category: "B", inputSchema: SCHEMA_TEXT_EDITOR,
    betas: ["computer-use-2025-04-29"], kiroNative: false
  },
  text_editor_20250728: {
    family: "text_editor", category: "B", inputSchema: SCHEMA_TEXT_EDITOR,
    betas: ["computer-use-2025-07-28"], kiroNative: false
  },
  memory_20250818: {
    family: "memory", category: "B", inputSchema: SCHEMA_MEMORY,
    betas: ["context-management-2025-06-27"], kiroNative: false
  },
  tool_search_tool_bm25: {
    family: "tool_search_bm25", category: "B", inputSchema: SCHEMA_TOOL_SEARCH_BM25,
    betas: ["search-tool-2025-08-13"], kiroNative: false
  },
  tool_search_tool_bm25_20251119: {
    family: "tool_search_bm25", category: "B", inputSchema: SCHEMA_TOOL_SEARCH_BM25,
    betas: ["search-tool-2025-08-13"], kiroNative: false
  },
  tool_search_tool_regex: {
    family: "tool_search_regex", category: "B", inputSchema: SCHEMA_TOOL_SEARCH_REGEX,
    betas: ["search-tool-2025-08-13"], kiroNative: false
  },
  tool_search_tool_regex_20251119: {
    family: "tool_search_regex", category: "B", inputSchema: SCHEMA_TOOL_SEARCH_REGEX,
    betas: ["search-tool-2025-08-13"], kiroNative: false
  }
});

// Default canonical name when a typed tool entry omits `name` (Anthropic's
// docs allow this for some tools — name defaults to the family).
const FAMILY_DEFAULT_NAME = Object.freeze({
  web_search: "web_search",
  web_fetch: "web_fetch",
  code_execution: "code_execution",
  bash: "bash",
  text_editor: "str_replace_based_edit_tool",
  memory: "memory",
  tool_search_bm25: "tool_search_tool_bm25",
  tool_search_regex: "tool_search_tool_regex"
});

const UNSUPPORTED = Object.freeze({
  category: "UNSUPPORTED",
  unsupported: true
});

/**
 * Resolve a tool entry by its `type` string.
 * Returns the registry entry, or an UNSUPPORTED sentinel for unknown types.
 * Pass a non-typed (custom) tool and you get UNSUPPORTED — caller should
 * branch on `isTypedTool` before resolving.
 */
export function resolveToolType(typeStr) {
  if (typeof typeStr !== "string" || !typeStr) return UNSUPPORTED;
  return REGISTRY[typeStr] || UNSUPPORTED;
}

/** True when the tool entry has a typed shape (carries a `type` field). */
export function isTypedTool(tool) {
  if (!tool || typeof tool !== "object") return false;
  if (typeof tool.type !== "string" || !tool.type) return false;
  // The literal `type: "custom"` shape is custom, not typed.
  if (tool.type === "custom") return false;
  // `type: "function"` is the OpenAI-style custom shape.
  if (tool.type === "function") return false;
  return true;
}

/**
 * Default canonical name for a typed tool when `name` is missing.
 * Returns `null` if the family has no documented default.
 */
export function defaultNameForFamily(family) {
  return FAMILY_DEFAULT_NAME[family] || null;
}

/**
 * Aggregate the Anthropic-Beta flags required by the typed tools in `tools[]`.
 * Returns a deduped array (preserves insertion order).
 */
export function collectBetaFlags(tools) {
  if (!Array.isArray(tools)) return [];
  const seen = new Set();
  const flags = [];
  for (const t of tools) {
    if (!isTypedTool(t)) continue;
    const entry = resolveToolType(t.type);
    if (entry.unsupported) continue;
    for (const flag of entry.betas || []) {
      if (!seen.has(flag)) {
        seen.add(flag);
        flags.push(flag);
      }
    }
  }
  return flags;
}

/**
 * Downgrade a typed tool to a custom-tool shape suitable for backends that
 * don't natively support typed tools (kr/ path). The returned tool has
 * `name`, `description`, `input_schema` — no `type` field.
 *
 * Returns `null` for unknown types — caller should fail loud (T6) rather
 * than emit a schemaless tool.
 */
export function downgradeTypedTool(tool) {
  if (!isTypedTool(tool)) return null;
  const entry = resolveToolType(tool.type);
  if (entry.unsupported) return null;

  const name = tool.name || defaultNameForFamily(entry.family);
  if (!name) return null;

  return {
    name,
    description: tool.description || `Anthropic ${entry.family} tool (${tool.type})`,
    input_schema: entry.inputSchema
  };
}

/** Returns true if the type string is registered. */
export function isKnownTypedTool(typeStr) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, typeStr);
}

export const TOOL_CATEGORIES = Object.freeze({ A: "A", B: "B", C: "C", UNSUPPORTED: "UNSUPPORTED" });

// Exposed for tests + diagnostics; never mutate.
export const _REGISTRY_FOR_TESTS = REGISTRY;
