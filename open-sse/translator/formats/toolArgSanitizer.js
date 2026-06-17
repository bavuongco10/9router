/**
 * Shared tool-call argument sanitizer.
 *
 * Used by both the OpenAI→Claude pivot response translator
 * (open-sse/translator/response/openai-to-claude.js) and the direct Kiro→Claude
 * response translator (open-sse/translator/response/kiro-to-claude.js) so the
 * direct route doesn't regress on bad tool params from non-Anthropic models.
 *
 * Two responsibilities:
 *   1. Strip the Claude OAuth cloaking prefix (`proxy_`) from tool names so the
 *      sanitizer can match the canonical tool by name (Read, Write, etc.).
 *   2. Coerce common bad-arg shapes the model-side may produce, e.g. string-typed
 *      `limit`/`offset` integers on the `Read` tool, out-of-range `limit`,
 *      malformed `pages` ranges on non-PDF reads.
 */

export const CLAUDE_OAUTH_TOOL_PREFIX = "proxy_";

export function sanitizeToolArgs(toolName, argsJson) {
  try {
    const args = JSON.parse(argsJson);
    const name =
      typeof toolName === "string" && toolName.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)
        ? toolName.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
        : toolName;
    if (name === "Read") sanitizeReadArgs(args);
    return JSON.stringify(args);
  } catch {
    return argsJson;
  }
}

export function sanitizeReadArgs(args) {
  if (typeof args.limit === "string" && /^\d+$/.test(args.limit)) {
    args.limit = Number(args.limit);
  }
  if (typeof args.offset === "string" && /^-?\d+$/.test(args.offset)) {
    args.offset = Number(args.offset);
  }

  if (typeof args.limit === "number") {
    if (args.limit > 2000) args.limit = 2000;
    if (args.limit < 1) delete args.limit;
  }
  if (typeof args.offset === "number" && args.offset < 0) args.offset = 0;

  if ("pages" in args && !isValidPdfPagesArg(args.file_path, args.pages)) {
    delete args.pages;
  }
}

export function isValidPdfPagesArg(filePath, pages) {
  return (
    typeof filePath === "string" &&
    filePath.toLowerCase().endsWith(".pdf") &&
    typeof pages === "string" &&
    /^\d+(?:-\d+)?$/.test(pages)
  );
}
