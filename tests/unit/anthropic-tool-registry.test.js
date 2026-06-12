/**
 * Unit tests for open-sse/config/anthropicToolRegistry.js
 */
import { describe, it, expect } from "vitest";
import {
  resolveToolType,
  isTypedTool,
  defaultNameForFamily,
  collectBetaFlags,
  downgradeTypedTool,
  isKnownTypedTool,
  TOOL_CATEGORIES,
} from "../../open-sse/config/anthropicToolRegistry.js";

describe("anthropicToolRegistry", () => {
  describe("resolveToolType", () => {
    it("returns category A for web_search", () => {
      const e = resolveToolType("web_search_20250305");
      expect(e.category).toBe("A");
      expect(e.family).toBe("web_search");
      expect(e.inputSchema.required).toEqual(["query"]);
    });

    it("returns category B for bash, text_editor, memory, tool_search", () => {
      expect(resolveToolType("bash_20250124").category).toBe("B");
      expect(resolveToolType("text_editor_20250728").category).toBe("B");
      expect(resolveToolType("memory_20250818").category).toBe("B");
      expect(resolveToolType("tool_search_tool_bm25").category).toBe("B");
      expect(resolveToolType("tool_search_tool_regex_20251119").category).toBe("B");
    });

    it("returns UNSUPPORTED sentinel for unknown types", () => {
      const e = resolveToolType("nonexistent_tool_99999999");
      expect(e.category).toBe("UNSUPPORTED");
      expect(e.unsupported).toBe(true);
    });

    it("returns UNSUPPORTED sentinel for null/undefined/empty", () => {
      expect(resolveToolType(null).unsupported).toBe(true);
      expect(resolveToolType(undefined).unsupported).toBe(true);
      expect(resolveToolType("").unsupported).toBe(true);
    });

    it("never crashes — registry never returns null", () => {
      expect(resolveToolType("garbage")).toBeTruthy();
      expect(resolveToolType(123)).toBeTruthy();
    });
  });

  describe("isTypedTool", () => {
    it("recognizes typed tools by `type` field", () => {
      expect(isTypedTool({ type: "web_search_20250305", name: "web_search" })).toBe(true);
      expect(isTypedTool({ type: "bash_20250124", name: "bash" })).toBe(true);
    });

    it("rejects custom tools (no type, or type:custom/function)", () => {
      expect(isTypedTool({ name: "my_tool", input_schema: {} })).toBe(false);
      expect(isTypedTool({ type: "custom", name: "my_tool" })).toBe(false);
      expect(isTypedTool({ type: "function", function: { name: "x" } })).toBe(false);
    });

    it("handles bad input gracefully", () => {
      expect(isTypedTool(null)).toBe(false);
      expect(isTypedTool({})).toBe(false);
      expect(isTypedTool("string")).toBe(false);
    });
  });

  describe("defaultNameForFamily", () => {
    it("returns canonical name for documented families", () => {
      expect(defaultNameForFamily("web_search")).toBe("web_search");
      expect(defaultNameForFamily("text_editor")).toBe("str_replace_based_edit_tool");
    });

    it("returns null for unknown family", () => {
      expect(defaultNameForFamily("unknown")).toBe(null);
    });
  });

  describe("collectBetaFlags", () => {
    it("collects unique flags across mixed tools", () => {
      const flags = collectBetaFlags([
        { type: "web_search_20250305", name: "web_search" },
        { type: "bash_20250124", name: "bash" },
        { type: "text_editor_20250124", name: "str_replace_based_edit_tool" },
        { name: "custom", input_schema: {} }
      ]);
      expect(flags).toContain("web-search-2025-03-05");
      expect(flags).toContain("computer-use-2025-01-24");
      expect(new Set(flags).size).toBe(flags.length);
    });

    it("returns empty array for non-array input", () => {
      expect(collectBetaFlags(null)).toEqual([]);
      expect(collectBetaFlags(undefined)).toEqual([]);
    });

    it("ignores unsupported types silently (caller decides on fail-loud)", () => {
      const flags = collectBetaFlags([{ type: "fake_tool_12345678", name: "x" }]);
      expect(flags).toEqual([]);
    });
  });

  describe("downgradeTypedTool", () => {
    it("downgrades web_search to custom shape", () => {
      const downgraded = downgradeTypedTool({
        type: "web_search_20250305",
        name: "web_search"
      });
      expect(downgraded.name).toBe("web_search");
      expect(downgraded.input_schema.required).toEqual(["query"]);
      expect(downgraded.type).toBeUndefined();
      expect(typeof downgraded.description).toBe("string");
    });

    it("preserves caller-provided description", () => {
      const d = downgradeTypedTool({
        type: "bash_20250124",
        name: "bash",
        description: "Run a shell command in the sandbox."
      });
      expect(d.description).toBe("Run a shell command in the sandbox.");
    });

    it("falls back to family default name when name is missing", () => {
      const d = downgradeTypedTool({ type: "text_editor_20250728" });
      expect(d.name).toBe("str_replace_based_edit_tool");
    });

    it("returns null for unknown types (caller fails loud)", () => {
      expect(downgradeTypedTool({ type: "fake_99999999", name: "x" })).toBe(null);
    });

    it("returns null for non-typed tools", () => {
      expect(downgradeTypedTool({ name: "custom", input_schema: {} })).toBe(null);
    });
  });

  describe("isKnownTypedTool", () => {
    it("only true for registered types", () => {
      expect(isKnownTypedTool("web_search_20250305")).toBe(true);
      expect(isKnownTypedTool("memory_20250818")).toBe(true);
      expect(isKnownTypedTool("nonexistent")).toBe(false);
      expect(isKnownTypedTool("custom")).toBe(false);
    });
  });

  describe("registry coverage", () => {
    it("covers every tool listed in fix-tool-issue spec §1", () => {
      const required = [
        // A
        "web_search_20250305", "web_search_20260209",
        "web_fetch_20250910", "web_fetch_20260209", "web_fetch_20260309",
        "code_execution_20250522", "code_execution_20250825", "code_execution_20260120",
        // B
        "bash_20250124",
        "text_editor_20250124", "text_editor_20250429", "text_editor_20250728",
        "memory_20250818",
        "tool_search_tool_bm25", "tool_search_tool_bm25_20251119",
        "tool_search_tool_regex", "tool_search_tool_regex_20251119"
      ];
      for (const t of required) {
        expect(isKnownTypedTool(t), `missing registry entry: ${t}`).toBe(true);
      }
    });
  });

  describe("TOOL_CATEGORIES", () => {
    it("exports A/B/C/UNSUPPORTED constants", () => {
      expect(TOOL_CATEGORIES.A).toBe("A");
      expect(TOOL_CATEGORIES.B).toBe("B");
      expect(TOOL_CATEGORIES.C).toBe("C");
      expect(TOOL_CATEGORIES.UNSUPPORTED).toBe("UNSUPPORTED");
    });
  });
});
