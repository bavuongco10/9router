# Task 13 — Advanced content blocks + Kiro-Go-style truncation

**Priority:** P2 (defensive — prevents specific 400s and silent drops)
**File:** `9router-development/open-sse/translator/request/claude-to-kiro.js` (mirror in `openai-to-kiro.js` where parity matters)

## Problem

Four content/tool shapes the direct translator doesn't yet handle. Each is real Claude API surface a real client can send. Severity ranges from "Kiro returns 400" (13a/13d) to "block silently lost" (13b/13c).

### 13a. Tool description length cap

`buildToolSpecs` in `claude-to-kiro.js:206-224` doesn't cap description length. Kiro's schema validator rejects descriptions over ~10K chars with `Improperly formed request`. Tools with long descriptions (Claude Code's `Task` tool, `Read` tool, MCP-bridged tools that copy upstream docs) are common. Quorinex/Kiro-Go uses **10237 chars** (`maxToolDescLen`, `proxy/translator.go:197`).

**Fix:**

```js
// At the top of claude-to-kiro.js
const MAX_TOOL_DESC_LEN = 10237; // matches Quorinex/Kiro-Go proxy/translator.go:197

// In buildToolSpecs (or wherever tool descriptions are read)
let description = t.description || `Tool: ${name}`;
if (description.length > MAX_TOOL_DESC_LEN) {
  description = description.slice(0, MAX_TOOL_DESC_LEN);
}
```

Mirror in `openai-to-kiro.js:222-227` for parity (same 400 trigger via the pivot path).

### 13b. `document` content blocks silently dropped

Anthropic supports `{type: "document", source: {type: "base64", media_type: "application/pdf", data: "..."}, citations: {enabled: true}}` for PDF + native document handling. Kiro doesn't have a document API. The translator's user-content extraction (`claude-to-kiro.js:267-296`) handles `text`, `image`, `tool_result` — a `document` block falls through silently.

**Fix:** drop with a marker (Kiro can't use the bytes; surfacing the title/filename is the best fallback):

```js
} else if (block.type === "document") {
  // Kiro has no document API. Surface the title/filename so the model knows
  // a document was provided, but skip the bytes.
  const title = block.title || block.context || "document";
  pendingUserContent.push(
    `[Document: ${title} — not forwarded; Kiro does not support document content]`
  );
}
```

### 13c. `image.source.type: "file"` silently dropped

Anthropic's Files API: `{type: "image", source: {type: "file", file_id: "file_..."}}`. The translator only handles `source.type === "base64"`. A file-source image is silently dropped.

Kiro can't dereference Anthropic's Files API. Two options:

**Option A — drop with marker (recommended for parity with pivot):**

```js
} else if (block.type === "image" && block.source?.type === "file") {
  pendingUserContent.push(
    `[Image: file_id=${block.source.file_id} — not forwarded; Kiro cannot dereference Anthropic Files API]`
  );
}
```

**Option B — fetch and inline:** Resolve the file_id via `client.beta.files.download()`, base64-encode, push as a normal Kiro image. This requires Anthropic credentials (which the Kiro path doesn't carry) and a network round-trip. Out of scope for this PR; spin out as a separate task if there's a real use case.

Same fix needed in `openai-to-kiro.js`'s image handling (lines 286-307), which only handles `image_url` data URIs and `image` base64 — the file-source variant is dropped on both routes.

### 13d. Anthropic server-side tool definitions break tool spec building

Anthropic-built tools have a different shape — no `input_schema`, just `{type: "web_search_20260209", name: "web_search"}` etc. `buildToolSpecs` in `claude-to-kiro.js:206-224` blindly reads `t.input_schema || {}`, producing nonsense tool specs that may 400 Kiro. Server-side tools that show up in `body.tools`:

| `type` | What it is |
|---|---|
| `bash_20250124` | Bash tool (server-side variant) |
| `text_editor_20250728` | Text editor (used in Claude Code) |
| `computer_20250124`, `computer_20251022` | Computer use |
| `web_search_20260209`, `web_fetch_20260209` | Web search / fetch |
| `code_execution_20260120` | Code execution sandbox |
| `memory_20250818` | Memory tool |

Kiro doesn't host any of these. Skip them entirely rather than forwarding malformed:

```js
const ANTHROPIC_SERVER_SIDE_TOOL_TYPE_RE =
  /^(bash|text_editor|computer|web_search|web_fetch|code_execution|memory)_\d{8}$/;

const buildToolSpecs = () =>
  tools
    .filter((t) => {
      if (typeof t.type === "string" && ANTHROPIC_SERVER_SIDE_TOOL_TYPE_RE.test(t.type)) {
        // log via task 12's logger if available
        return false;
      }
      return true;
    })
    .map((t) => {
      const name = t.name;
      let description = t.description || `Tool: ${name}`;
      if (description.length > MAX_TOOL_DESC_LEN) description = description.slice(0, MAX_TOOL_DESC_LEN);
      const schema = t.input_schema || {};
      const normalizedSchema =
        Object.keys(schema).length === 0
          ? { type: "object", properties: {}, required: [] }
          : { ...schema, required: schema.required ?? [] };
      return {
        toolSpecification: { name, description, inputSchema: { json: normalizedSchema } },
      };
    });
```

The regex matches the established Anthropic versioned-tool naming (`<name>_YYYYMMDD`). New tool types will follow the same convention. Mirror in `openai-to-kiro.js`'s tool conversion for parity (the OpenAI side reads `t.function?.name`, but a request that hybridizes OpenAI shape with Anthropic server-tools is rare; document as known limitation if you don't fix both).

## Acceptance criteria

- 13a: Test verifies a tool with a 20,000-char description produces a Kiro toolSpec with `description.length === 10237`. Tool with normal description passes through unchanged.
- 13b: Test sends a base64 PDF document block, verifies the resulting Kiro currentMessage user content contains `[Document: ...]` and no error is thrown. The document bytes are not present in the payload (verified by absence of base64 markers in serialized payload).
- 13c: Test sends `{type: "image", source: {type: "file", file_id: "file_test"}}`, verifies content includes `[Image: file_id=file_test ...]`. No throw, no malformed images entry.
- 13d: Test sends `tools: [{type: "web_search_20260209", name: "web_search"}, {name: "myTool", description: "x", input_schema: {...}}]`, verifies the resulting Kiro `userInputMessageContext.tools` contains only `myTool`. The Anthropic-built tool is filtered out.
- `pnpm vitest run tests/translator/` green.

## How to verify

```bash
cd 9router-development
pnpm vitest run tests/translator/
```

For 13a manual check: take Claude Code's `Task` tool description (which is multiple kilobytes), send it through, dump the Kiro payload, and confirm the `description` field is exactly 10237 chars.

## Why this matters

13a is the most likely to surface: any sufficiently long tool description from Claude Code, MCP-bridged tools, or custom apps that copy upstream docs into descriptions will 400 today. 13d is the same thing in a different shape — declaring an Anthropic server-side tool currently produces a malformed Kiro request. 13b/13c are about not silently losing user-supplied content (PDF analysis, file-referenced images).

## References

- Quorinex/Kiro-Go tool description cap: `proxy/translator.go:197` (`maxToolDescLen = 10237`).
- Anthropic document blocks: `shared/tool-use-concepts.md` in the claude-api skill (search "document").
- Anthropic Files API: `shared/files-api.md` and the language-specific Files API docs.
- Anthropic server-side tools: `shared/tool-use-concepts.md` § Server-Side Tools — full list with version tags.
- Pivot tool spec building: `open-sse/translator/request/openai-to-kiro.js:221-243` (mirror changes here for parity).
