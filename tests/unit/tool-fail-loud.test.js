/**
 * T6 — fail-loud + observability tests.
 *
 * Three layers exercised:
 *   1. cc/ path: prepareClaudeRequest throws UNSUPPORTED_TOOL_TYPE on unknown
 *      Anthropic typed tool when provider is "claude".
 *   2. kr/ path: claudeToKiroRequest throws UNSUPPORTED_TOOL_TYPE on unknown
 *      Anthropic typed tool — the registry's downgradeTypedTool returns null
 *      and the translator surfaces it instead of emitting a schemaless spec.
 *   3. classifier: classifyTranslatorError + unsupportedToolTypeResult turn
 *      that throw into a structured 422 with the Anthropic error envelope.
 *      Other errors must NOT be classified as 422 — the chatCore wrapper
 *      relies on classifyTranslatorError returning null to fall through.
 */
import { describe, it, expect } from "vitest";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.js";
import { claudeToKiroRequest } from "../../open-sse/translator/request/claude-to-kiro.js";
import {
  classifyTranslatorError,
  unsupportedToolTypeResult
} from "../../open-sse/utils/error.js";

describe("T6 — UNSUPPORTED_TOOL_TYPE throw paths", () => {
  it("prepareClaudeRequest with provider=claude throws on unknown typed tool", () => {
    expect(() =>
      prepareClaudeRequest(
        {
          tools: [{ type: "fake_99999999", name: "x" }],
          messages: [{ role: "user", content: "hi" }],
        },
        "claude",
        null,
        null
      )
    ).toThrow(/UNSUPPORTED_TOOL_TYPE: fake_99999999/);
  });

  it("claudeToKiroRequest throws on unknown typed tool", () => {
    expect(() =>
      claudeToKiroRequest(
        "claude-sonnet-4.5",
        {
          tools: [{ type: "fake_99999999", name: "x" }],
          messages: [{ role: "user", content: "hi" }],
        },
        true,
        {}
      )
    ).toThrow(/UNSUPPORTED_TOOL_TYPE: fake_99999999/);
  });
});

describe("T6 — classifyTranslatorError", () => {
  it("returns a 422 result for an UNSUPPORTED_TOOL_TYPE error", () => {
    const err = new Error("UNSUPPORTED_TOOL_TYPE: fake_99999999");
    const result = classifyTranslatorError(err);

    expect(result).not.toBeNull();
    expect(result.success).toBe(false);
    expect(result.status).toBe(422);
    expect(result.error).toBe("UNSUPPORTED_TOOL_TYPE: fake_99999999");
    expect(result.response).toBeInstanceOf(Response);
    expect(result.response.status).toBe(422);
  });

  it("422 response body matches the Anthropic error envelope", async () => {
    const err = new Error("UNSUPPORTED_TOOL_TYPE: fake_99999999");
    const { response } = classifyTranslatorError(err);
    const body = await response.json();

    expect(body).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "UNSUPPORTED_TOOL_TYPE",
        message: "Unsupported Anthropic typed tool: fake_99999999",
        tool_type: "fake_99999999"
      }
    });
    expect(response.headers.get("Content-Type")).toBe("application/json");
  });

  it("returns null for non-UNSUPPORTED_TOOL_TYPE errors", () => {
    expect(classifyTranslatorError(new Error("some other failure"))).toBeNull();
    expect(classifyTranslatorError(new Error(""))).toBeNull();
    expect(classifyTranslatorError(null)).toBeNull();
    expect(classifyTranslatorError(undefined)).toBeNull();
    // Edge: prefix without trailing type still classifies — better to surface
    // a structured "unknown" 422 than a 500 for malformed throws.
    const partial = classifyTranslatorError(new Error("UNSUPPORTED_TOOL_TYPE: "));
    expect(partial).not.toBeNull();
    expect(partial.status).toBe(422);
  });

  it("returns null when message is not a string", () => {
    const err = new Error();
    err.message = 42;
    expect(classifyTranslatorError(err)).toBeNull();
  });
});

describe("T6 — unsupportedToolTypeResult", () => {
  it("builds a 422 with the rejected tool type carried into the body", async () => {
    const result = unsupportedToolTypeResult("web_search_99999999");

    expect(result.status).toBe(422);
    expect(result.error).toBe("UNSUPPORTED_TOOL_TYPE: web_search_99999999");

    const body = await result.response.json();
    expect(body.type).toBe("error");
    expect(body.error.code).toBe("UNSUPPORTED_TOOL_TYPE");
    expect(body.error.tool_type).toBe("web_search_99999999");
    expect(body.error.message).toContain("web_search_99999999");
  });

  it("falls back to 'unknown' when no type is provided", async () => {
    const result = unsupportedToolTypeResult();
    const body = await result.response.json();
    expect(body.error.tool_type).toBe("unknown");
  });
});
