/**
 * Claude → Kiro Request Translator (DIRECT route, no OpenAI pivot)
 *
 * Converts Anthropic Messages API requests straight to Kiro / AWS
 * CodeWhisperer `GenerateAssistantResponse` payloads. Mirrors the pivot path
 * (claude→openai→kiro) byte-for-byte on every behavior that defines the
 * drop-in contract:
 *
 *   - `body.system` is injected as a synthetic leading user message in history
 *     (pivot equivalent: claude→openai → system role, openai→kiro normalize to
 *     user), NOT prepended to currentMessage.
 *   - `maxTokens` is hardcoded to 32000 to match `buildKiroPayload`.
 *   - The two 400-guards are mirrored: flattenClaudeToolInteractions (no tools
 *     provided) and reconcileOrphanedToolResults (orphaned tool_result blocks).
 *   - Tool description length is capped at 10237 chars (matches Quorinex/Kiro-Go
 *     proxy/translator.go:197 — protects Kiro's schema validator).
 *   - Anthropic server-side tool definitions (web_search_*, bash_*, etc.) are
 *     filtered out — Kiro doesn't host them.
 *   - `tool_result.is_error: true` maps to Kiro `status: "error"` (not "success").
 *   - `role: "system"` mid-conversation messages collapse to user content with a
 *     marker (mirrors the pivot's claude→openai→kiro normalization).
 *   - `stop_sequences` forwarded to inferenceConfig.stopSequences.
 *
 * It also handles the 9router-synthetic `-agentic` / `-thinking` suffixes and
 * the `<thinking_mode>enabled</thinking_mode>` reasoning trigger.
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { v4 as uuidv4 } from "uuid";
import {
  resolveKiroModel,
  isThinkingEnabled,
  buildThinkingSystemPrefix,
  KIRO_AGENTIC_SYSTEM_PROMPT,
} from "../../config/kiroConstants.js";

const MAX_TOOL_DESC_LEN = 10237;

const ANTHROPIC_SERVER_SIDE_TOOL_TYPE_RE =
  /^(bash|text_editor|computer|web_search|web_fetch|code_execution|memory)_\d{8}$/;

/** Stringify a tool_use input as a readable line. */
function toolUseToText(name, input) {
  let argStr;
  try {
    argStr = typeof input === "string" ? input : JSON.stringify(input ?? {});
  } catch {
    argStr = "{}";
  }
  return `[Tool call: ${name || "unknown"}(${argStr})]`;
}

/** Render a Claude tool_result block's content as a readable line. */
function toolResultBlockToText(content) {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .filter(Boolean)
      .join("\n");
  } else if (content) {
    try {
      text = JSON.stringify(content);
    } catch {
      text = "";
    }
  }
  return `[Tool result: ${text}]`;
}

/**
 * Log fields the direct route silently drops because Kiro has no equivalent.
 * Default-off (only fires when log.debug exists). Helps operators diagnose
 * "direct route behaves differently from Anthropic-direct" without tcpdump.
 */
function logDroppedClaudeFields(body, log) {
  if (!log?.debug) return;
  const dropped = [];

  if (body.cache_control) dropped.push("cache_control(top-level)");
  if (Array.isArray(body.system) && body.system.some((s) => s?.cache_control)) {
    dropped.push("cache_control(system blocks)");
  }
  if (Array.isArray(body.tools) && body.tools.some((t) => t?.cache_control)) {
    dropped.push("cache_control(tools)");
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (Array.isArray(m.content) && m.content.some((c) => c?.cache_control)) {
        dropped.push("cache_control(message blocks)");
        break;
      }
    }
  }

  if (body.tool_choice) dropped.push(`tool_choice=${JSON.stringify(body.tool_choice)}`);
  if (body.output_config) {
    if (body.output_config.format) dropped.push("output_config.format");
    if (body.output_config.effort) dropped.push(`output_config.effort=${body.output_config.effort}`);
    if (body.output_config.task_budget) dropped.push("output_config.task_budget");
  }
  if (body.metadata?.user_id) dropped.push("metadata.user_id");
  if (body.top_k !== undefined) dropped.push("top_k");
  if (body.service_tier) dropped.push(`service_tier=${body.service_tier}`);

  if (dropped.length > 0) {
    log.debug("CLAUDE_TO_KIRO", `Dropped unsupported Claude fields: ${dropped.join(", ")}`);
  }
}

/**
 * When the client sent no tools, rewrite every tool_use (assistant) and
 * tool_result (user) content block into plain text. Keeps text + images.
 */
function flattenClaudeToolInteractions(messages) {
  const out = [];
  for (const msg of messages) {
    if (!msg) continue;

    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push(block.text);
        } else if (block.type === "tool_use") {
          parts.push(toolUseToText(block.name, block.input));
        } else if (block.type === "thinking" && block.thinking) {
          parts.push(`[Previous thinking: ${block.thinking}]`);
        }
      }
      out.push({ ...msg, content: parts.join("\n") });
      continue;
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      const newContent = msg.content.map((block) =>
        block.type === "tool_result"
          ? { type: "text", text: toolResultBlockToText(block.content) }
          : block
      );
      out.push({ ...msg, content: newContent });
      continue;
    }

    out.push(msg);
  }
  return out;
}

/**
 * Synthesize a leading user message that carries body.system as text. This is
 * how the pivot effectively places system content: claude→openai emits a
 * `role: "system"` message, openai→kiro normalizes system→user, and the result
 * is a leading user turn. We do the same in one step.
 */
function buildSystemUserMessage(systemField) {
  let text = "";
  if (typeof systemField === "string") {
    text = systemField;
  } else if (Array.isArray(systemField)) {
    text = systemField
      .map((s) => (typeof s === "string" ? s : s?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  return { role: "user", content: text };
}

/**
 * Convert Claude messages to Kiro history + currentMessage.
 * Kiro requires alternating user/assistant turns; consecutive same-role
 * messages are merged.
 */
function convertClaudeMessagesToKiro(messages, tools, model) {
  const history = [];
  let currentMessage = null;

  let pendingUserContent = [];
  let pendingAssistantContent = [];
  let pendingToolResults = [];
  let pendingImages = [];
  let currentRole = null;
  let toolsInjected = false;

  const clientProvidedTools = Array.isArray(tools) && tools.length > 0;

  const buildToolSpecs = () =>
    tools
      .filter((t) => {
        if (typeof t.type === "string" && ANTHROPIC_SERVER_SIDE_TOOL_TYPE_RE.test(t.type)) {
          return false;
        }
        return true;
      })
      .map((t) => {
        const name = t.name;
        let description = t.description || `Tool: ${name}`;
        if (description.length > MAX_TOOL_DESC_LEN) {
          description = description.slice(0, MAX_TOOL_DESC_LEN);
        }
        const schema = t.input_schema || {};
        const normalizedSchema =
          Object.keys(schema).length === 0
            ? { type: "object", properties: {}, required: [] }
            : { ...schema, required: schema.required ?? [] };
        return {
          toolSpecification: {
            name,
            description,
            inputSchema: { json: normalizedSchema },
          },
        };
      });

  const flushPending = () => {
    if (currentRole === "user") {
      const content = pendingUserContent.join("\n\n").trim() || "continue";
      const userMsg = { userInputMessage: { content, modelId: model } };

      if (pendingImages.length > 0) {
        userMsg.userInputMessage.images = pendingImages;
      }
      if (pendingToolResults.length > 0) {
        userMsg.userInputMessage.userInputMessageContext = {
          toolResults: pendingToolResults,
        };
      }
      if (clientProvidedTools && !toolsInjected) {
        if (!userMsg.userInputMessage.userInputMessageContext) {
          userMsg.userInputMessage.userInputMessageContext = {};
        }
        userMsg.userInputMessage.userInputMessageContext.tools = buildToolSpecs();
        toolsInjected = true;
      }

      history.push(userMsg);
      currentMessage = userMsg;
      pendingUserContent = [];
      pendingToolResults = [];
      pendingImages = [];
    } else if (currentRole === "assistant") {
      const content = pendingAssistantContent.join("\n\n").trim() || "...";
      history.push({ assistantResponseMessage: { content } });
      pendingAssistantContent = [];
    }
  };

  for (const msg of messages) {
    let role = msg.role;
    // mid-conversation-system beta: collapse role:"system" → user with a marker.
    // Mirrors the pivot's claude→openai→kiro normalization.
    if (role === "system") {
      role = "user";
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .map((c) => (typeof c === "string" ? c : c?.text || ""))
          .filter(Boolean)
          .join("\n");
      }
      if (text) {
        if (role !== currentRole && currentRole !== null) flushPending();
        currentRole = "user";
        pendingUserContent.push(`[System: ${text}]`);
      }
      continue;
    }

    if (role !== currentRole && currentRole !== null) flushPending();
    currentRole = role;

    if (role === "user") {
      if (typeof msg.content === "string") {
        pendingUserContent.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            pendingUserContent.push(block.text);
          } else if (block.type === "image") {
            const src = block.source || {};
            if (src.type === "base64" && src.data) {
              const mediaType = src.media_type || "image/png";
              const format = mediaType.split("/")[1] || mediaType;
              pendingImages.push({ format, source: { bytes: src.data } });
            } else if (src.type === "url" && src.url) {
              pendingUserContent.push(`[Image: ${src.url} — not forwarded; Kiro requires base64]`);
            } else if (src.type === "file" && src.file_id) {
              pendingUserContent.push(
                `[Image: file_id=${src.file_id} — not forwarded; Kiro cannot dereference Anthropic Files API]`
              );
            }
          } else if (block.type === "document") {
            const title = block.title || block.context || "document";
            pendingUserContent.push(
              `[Document: ${title} — not forwarded; Kiro does not support document content]`
            );
          } else if (block.type === "tool_result") {
            let resultContent = "";
            if (typeof block.content === "string") {
              resultContent = block.content;
            } else if (Array.isArray(block.content)) {
              resultContent =
                block.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n") || JSON.stringify(block.content);
            } else if (block.content) {
              resultContent = JSON.stringify(block.content);
            }
            pendingToolResults.push({
              toolUseId: block.tool_use_id,
              status: block.is_error === true ? "error" : "success",
              content: [{ text: resultContent }],
            });
          }
        }
      }
    } else if (role === "assistant") {
      let textContent = "";
      const toolUses = [];
      if (typeof msg.content === "string") {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            textContent += block.text;
          } else if (block.type === "tool_use") {
            toolUses.push({
              toolUseId: block.id,
              name: block.name,
              input: block.input || {},
            });
          } else if (block.type === "thinking" && block.thinking) {
            textContent += `\n[Previous thinking: ${block.thinking}]\n`;
          }
          // server_tool_use / *_tool_result / fallback / redacted_thinking:
          // intentionally dropped — Kiro has no equivalent surface.
        }
      }
      if (textContent) pendingAssistantContent.push(textContent);

      if (toolUses.length > 0) {
        flushPending();
        const lastMsg = history[history.length - 1];
        if (lastMsg?.assistantResponseMessage) {
          lastMsg.assistantResponseMessage.toolUses = toolUses;
        }
        currentRole = null;
      }
    }
  }

  if (currentRole !== null) flushPending();

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].userInputMessage) {
      currentMessage = history.splice(i, 1)[0];
      break;
    }
  }

  const firstHistoryTools =
    history[0]?.userInputMessage?.userInputMessageContext?.tools;

  history.forEach((item) => {
    if (item.userInputMessage?.userInputMessageContext?.tools) {
      delete item.userInputMessage.userInputMessageContext.tools;
    }
    if (
      item.userInputMessage?.userInputMessageContext &&
      Object.keys(item.userInputMessage.userInputMessageContext).length === 0
    ) {
      delete item.userInputMessage.userInputMessageContext;
    }
    if (item.userInputMessage && !item.userInputMessage.modelId) {
      item.userInputMessage.modelId = model;
    }
  });

  const mergedHistory = [];
  for (const current of history) {
    const prev = mergedHistory[mergedHistory.length - 1];
    if (current.userInputMessage && prev?.userInputMessage) {
      prev.userInputMessage.content += "\n\n" + current.userInputMessage.content;
      const prevCtx = prev.userInputMessage.userInputMessageContext;
      const curCtx = current.userInputMessage.userInputMessageContext;
      if (curCtx) {
        if (!prevCtx) {
          prev.userInputMessage.userInputMessageContext = curCtx;
        } else {
          if (curCtx.toolResults?.length > 0) {
            prevCtx.toolResults = [
              ...(prevCtx.toolResults || []),
              ...curCtx.toolResults,
            ];
          }
          if (curCtx.tools?.length > 0) {
            prevCtx.tools = [...(prevCtx.tools || []), ...curCtx.tools];
          }
        }
      }
    } else {
      mergedHistory.push(current);
    }
  }

  if (!currentMessage) {
    currentMessage = { userInputMessage: { content: "", modelId: model } };
  }

  if (
    firstHistoryTools?.length > 0 &&
    !currentMessage.userInputMessage.userInputMessageContext?.tools
  ) {
    if (!currentMessage.userInputMessage.userInputMessageContext) {
      currentMessage.userInputMessage.userInputMessageContext = {};
    }
    currentMessage.userInputMessage.userInputMessageContext.tools =
      firstHistoryTools;
  }

  return { history: mergedHistory, currentMessage };
}

/**
 * Fold orphaned toolResults (those whose toolUseId has no matching toolUse in
 * any assistant turn) back into the user text.
 */
function reconcileOrphanedToolResults(history, currentMessage) {
  const validIds = new Set();
  for (const h of history) {
    const arm = h.assistantResponseMessage;
    if (!arm) continue;
    for (const tu of arm.toolUses || []) {
      if (tu.toolUseId) validIds.add(tu.toolUseId);
    }
  }

  const carriers = currentMessage ? [...history, currentMessage] : history;
  for (const item of carriers) {
    const uim = item.userInputMessage;
    const ctx = uim?.userInputMessageContext;
    if (!ctx?.toolResults?.length) continue;

    const kept = [];
    const salvaged = [];
    for (const tr of ctx.toolResults) {
      if (validIds.has(tr.toolUseId)) {
        kept.push(tr);
      } else {
        const text = Array.isArray(tr.content)
          ? tr.content.map((c) => c?.text || "").join("\n")
          : "";
        salvaged.push(`[Tool result: ${text}]`);
      }
    }

    if (salvaged.length === 0) continue;

    const extra = salvaged.join("\n");
    uim.content = uim.content ? `${uim.content}\n\n${extra}` : extra;
    ctx.toolResults = kept;
    if (kept.length === 0 && !ctx.tools?.length) {
      delete uim.userInputMessageContext;
    }
  }
}

/**
 * Build a Kiro payload directly from a Claude Messages API request body.
 * Optional `log` (5th arg) enables silent-drop diagnostics.
 */
export function claudeToKiroRequest(model, body, stream, credentials, log) {
  logDroppedClaudeFields(body, log);

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const clientProvidedTools = tools.length > 0;
  // Match pivot: hardcoded 32000 (buildKiroPayload, openai-to-kiro.js:514).
  const maxTokens = 32000;
  const temperature = body.temperature;
  const topP = body.top_p;

  // Inject body.system as a synthetic leading user message in history (matches
  // the pivot's claude→openai→kiro effective placement).
  const systemMsg = body.system ? buildSystemUserMessage(body.system) : null;
  if (systemMsg) {
    messages = [systemMsg, ...messages];
  }

  const {
    upstream: upstreamModel,
    agentic,
    thinking: modelImpliesThinking,
  } = resolveKiroModel(model);
  const thinkingEnabled =
    modelImpliesThinking || isThinkingEnabled(body, null, model);

  if (!clientProvidedTools) {
    messages = flattenClaudeToolInteractions(messages);
  }

  const { history, currentMessage } = convertClaudeMessagesToKiro(
    messages,
    tools,
    upstreamModel
  );

  if (clientProvidedTools) {
    reconcileOrphanedToolResults(history, currentMessage);
  }

  const profileArn = credentials?.providerSpecificData?.profileArn || "";

  let finalContent = currentMessage?.userInputMessage?.content || "";

  // Prefix order matches pivot: thinking_mode tag, timestamp marker, agentic prompt.
  const timestamp = new Date().toISOString();
  const prefixParts = [];
  if (thinkingEnabled) prefixParts.push(buildThinkingSystemPrefix());
  prefixParts.push(`[Context: Current time is ${timestamp}]`);
  if (agentic) prefixParts.push(KIRO_AGENTIC_SYSTEM_PROMPT);
  finalContent = `${prefixParts.join("\n\n")}\n\n${finalContent}`;

  const payload = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: uuidv4(),
      currentMessage: {
        userInputMessage: {
          content: finalContent,
          modelId: upstreamModel,
          origin: "AI_EDITOR",
          ...(currentMessage?.userInputMessage?.userInputMessageContext && {
            userInputMessageContext:
              currentMessage.userInputMessage.userInputMessageContext,
          }),
          ...(currentMessage?.userInputMessage?.images?.length > 0 && {
            images: currentMessage.userInputMessage.images,
          }),
        },
      },
      history,
    },
  };

  if (profileArn) payload.profileArn = profileArn;

  if (maxTokens || temperature !== undefined || topP !== undefined) {
    payload.inferenceConfig = {};
    if (maxTokens) payload.inferenceConfig.maxTokens = maxTokens;
    if (temperature !== undefined) payload.inferenceConfig.temperature = temperature;
    if (topP !== undefined) payload.inferenceConfig.topP = topP;
  }

  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    if (!payload.inferenceConfig) payload.inferenceConfig = {};
    payload.inferenceConfig.stopSequences = body.stop_sequences;
  }

  Object.defineProperty(payload, "_kiroUpstreamModel", {
    value: upstreamModel,
    enumerable: false,
  });

  return payload;
}

register(FORMATS.CLAUDE, FORMATS.KIRO, claudeToKiroRequest, null);
