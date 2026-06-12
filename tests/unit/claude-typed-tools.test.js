/**
 * Unit tests for cc/ path typed-tool passthrough (T2).
 *
 * Two invariants:
 *   1. Custom tools still get the _ide cloak suffix; typed tools (carrying a
 *      `type` field like "web_search_20250305") pass through unchanged.
 *      Anthropic rejects typed tools whose `name` doesn't match the canonical
 *      for the type, so renaming web_search → web_search_ide produces a 400.
 *   2. The cc/ executor's transformRequest collects per-tool Anthropic-Beta
 *      flags from the registry and stashes them on body._extraBetaFlags so
 *      buildHeaders can union them into the outbound `anthropic-beta` header.
 */
import { describe, it, expect } from "vitest";
import { cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("cloakClaudeTools — typed tool passthrough", () => {
  it("suffixes a custom tool with _ide and records it in toolNameMap", () => {
    const body = {
      tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    };

    const { body: cloaked, toolNameMap } = cloakClaudeTools(body);

    const customs = cloaked.tools.filter(t => t.name === "read_file_ide");
    expect(customs).toHaveLength(1);
    expect(toolNameMap).toBeInstanceOf(Map);
    expect(toolNameMap.get("read_file_ide")).toBe("read_file");
  });

  it("passes a typed tool through unchanged and never adds it to toolNameMap", () => {
    const body = {
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "search the web" }],
    };

    const { body: cloaked, toolNameMap } = cloakClaudeTools(body);

    // The web_search entry must remain in tools[] with its canonical name.
    const ws = cloaked.tools.find(t => t.type === "web_search_20250305");
    expect(ws).toBeDefined();
    expect(ws.name).toBe("web_search");
    // No _ide-suffixed copy exists.
    expect(cloaked.tools.find(t => t.name === "web_search_ide")).toBeUndefined();
    // toolNameMap is null OR has no entry for web_search* — either way the
    // typed tool must not be tracked as cloaked.
    if (toolNameMap) {
      expect(toolNameMap.has("web_search_ide")).toBe(false);
      for (const [, original] of toolNameMap) {
        expect(original).not.toBe("web_search");
      }
    }
  });

  it("mixed typed + custom: typed unchanged, custom suffixed; tool_use names follow", () => {
    const body = {
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { name: "exec", description: "run", input_schema: { type: "object" } },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu1", name: "web_search", input: { query: "x" } },
            { type: "tool_use", id: "tu2", name: "exec", input: { cmd: "ls" } },
          ],
        },
      ],
    };

    const { body: cloaked, toolNameMap } = cloakClaudeTools(body);

    const ws = cloaked.tools.find(t => t.type === "web_search_20250305");
    expect(ws.name).toBe("web_search");
    const execTool = cloaked.tools.find(t => t.name === "exec_ide");
    expect(execTool).toBeDefined();

    // Message-history tool_use blocks: typed-tool name kept canonical,
    // custom-tool name suffixed.
    const blocks = cloaked.messages[0].content;
    const wsBlock = blocks.find(b => b.id === "tu1");
    const execBlock = blocks.find(b => b.id === "tu2");
    expect(wsBlock.name).toBe("web_search");
    expect(execBlock.name).toBe("exec_ide");

    // toolNameMap only carries the custom tool.
    expect(toolNameMap.size).toBe(1);
    expect(toolNameMap.get("exec_ide")).toBe("exec");
  });
});

describe("prepareClaudeRequest — fail loud on unknown typed tool", () => {
  it("throws UNSUPPORTED_TOOL_TYPE with the unrecognized type when provider is claude", () => {
    expect(() =>
      prepareClaudeRequest(
        {
          tools: [{ type: "made_up_tool_20990101", name: "x" }],
          messages: [{ role: "user", content: "hi" }],
        },
        "claude",
        null,
        null
      )
    ).toThrow(/UNSUPPORTED_TOOL_TYPE: made_up_tool_20990101/);
  });

  it("does not throw for a known typed tool", () => {
    expect(() =>
      prepareClaudeRequest(
        {
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: "hi" }],
        },
        "claude",
        null,
        null
      )
    ).not.toThrow();
  });

  it("does not throw for a custom tool (no type field)", () => {
    expect(() =>
      prepareClaudeRequest(
        {
          tools: [{ name: "my_tool", input_schema: { type: "object" } }],
          messages: [{ role: "user", content: "hi" }],
        },
        "claude",
        null,
        null
      )
    ).not.toThrow();
  });
});

describe("DefaultExecutor.transformRequest — beta flag collection (cc/ path)", () => {
  it("stashes _extraBetaFlags on the body for typed tools", () => {
    const exec = new DefaultExecutor("claude");
    const body = {
      tools: [
        { type: "web_search_20250305", name: "web_search" },
        { type: "bash_20250124", name: "bash" },
      ],
      messages: [{ role: "user", content: "hi" }],
    };

    const transformed = exec.transformRequest("claude-opus-4-7", body);

    expect(Array.isArray(transformed._extraBetaFlags)).toBe(true);
    expect(transformed._extraBetaFlags).toContain("web-search-2025-03-05");
    expect(transformed._extraBetaFlags).toContain("computer-use-2025-01-24");
    // Deduped — every flag appears at most once.
    expect(new Set(transformed._extraBetaFlags).size).toBe(transformed._extraBetaFlags.length);
  });

  it("does not stash _extraBetaFlags when there are no typed tools", () => {
    const exec = new DefaultExecutor("claude");
    const body = {
      tools: [{ name: "my_custom", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    };

    const transformed = exec.transformRequest("claude-opus-4-7", body);

    expect(transformed._extraBetaFlags).toBeUndefined();
  });

  it("does not stash _extraBetaFlags for non-claude providers", () => {
    const exec = new DefaultExecutor("glm");
    const body = {
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: "hi" }],
    };

    const transformed = exec.transformRequest("glm-4-plus", body);

    expect(transformed._extraBetaFlags).toBeUndefined();
  });
});

describe("DefaultExecutor.buildHeaders — anthropic-beta merge", () => {
  it("unions per-tool flags into the outbound anthropic-beta header and removes _extraBetaFlags from the body", () => {
    const exec = new DefaultExecutor("claude");
    const body = {
      _extraBetaFlags: ["web-search-2025-03-05", "computer-use-2025-01-24"],
    };

    const headers = exec.buildHeaders({ apiKey: "test-key" }, true, body);

    const beta = headers["anthropic-beta"] || headers["Anthropic-Beta"];
    expect(beta).toBeDefined();
    const flags = beta.split(",").map(s => s.trim());
    expect(flags).toContain("web-search-2025-03-05");
    expect(flags).toContain("computer-use-2025-01-24");
    // Static CLI flags are still present alongside.
    expect(flags).toContain("claude-code-20250219");

    // Internal field is stripped.
    expect(body._extraBetaFlags).toBeUndefined();
  });
});
