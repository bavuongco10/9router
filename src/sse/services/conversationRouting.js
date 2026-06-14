/**
 * Per-conversation sticky connection routing (weighted round-robin).
 *
 * When a provider's round-robin strategy has `perConversation` enabled, every turn of the
 * same conversation is pinned to the same upstream connection so the provider-side prompt
 * cache (keyed by account+model+prefix) stays warm. NEW conversations are distributed across
 * connections by a weighted round-robin that respects priority order: each connection takes
 * `weight` new conversations before the cursor advances to the next.
 *
 * State is in-memory only (best-effort, like open-sse/services/combo.js): affinity is lost on
 * restart, which is fine — it just rewarms a cache prefix once.
 */

/** conversationKey -> { connectionId, lastSeen } */
const conversationAssignments = new Map();
/** providerId -> { connectionId, count } (weighted round-robin cursor) */
const weightedCursor = new Map();

// Bound memory: drop assignments unused for longer than the max cache TTL window.
const ASSIGNMENT_TTL_MS = 2 * 60 * 60 * 1000; // 2h
const SWEEP_EVERY = 500;
let setsSinceSweep = 0;

function sweepExpired(now) {
  for (const [key, entry] of conversationAssignments) {
    if (!entry || now - entry.lastSeen > ASSIGNMENT_TTL_MS) {
      conversationAssignments.delete(key);
    }
  }
}

/**
 * Fast, stable, non-cryptographic string hash (FNV-1a, 32-bit) -> hex.
 * We only need a deterministic distribution key, not collision resistance.
 */
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// Bound how much text feeds the hash — the conversation prefix is stable, no need to read it all.
const MAX_TEXT = 4000;

function textFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .join(" ");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return "";
}

function extractSystemText(body) {
  if (!body) return "";
  // Claude shape: top-level `system` (string or content blocks)
  let sys = textFromContent(body.system);
  // OpenAI shape: a system/developer message inside messages
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  for (const m of messages) {
    if (m && (m.role === "system" || m.role === "developer")) {
      sys += " " + textFromContent(m.content);
    }
  }
  return sys.slice(0, MAX_TEXT);
}

function extractFirstUserText(body) {
  if (!body) return "";
  const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  const firstUser = messages.find((m) => m && m.role === "user");
  return textFromContent(firstUser?.content).slice(0, MAX_TEXT);
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  if (typeof headers === "object") return headers[name] ?? null;
  return null;
}

/**
 * Derive a stable conversation key from a request.
 * - Honors an explicit `x-conversation-id` / `x-session-id` header if present.
 * - Otherwise hashes provider + model + system prompt + first user message — the parts that
 *   stay byte-stable across a conversation's turns (and that the provider cache keys on).
 * Returns null when nothing usable can be derived (caller falls back to normal round-robin).
 *
 * @param {{ provider?: string, model?: string, body?: object, headers?: Headers|object }} args
 * @returns {string|null}
 */
export function deriveConversationKey({ provider, model, body, headers } = {}) {
  const prov = provider || "";
  const explicit = headerValue(headers, "x-conversation-id") || headerValue(headers, "x-session-id");
  if (explicit) return `${prov}:${explicit}`;

  const system = extractSystemText(body);
  const firstUser = extractFirstUserText(body);
  if (!system && !firstUser) return null;

  return `${prov}:${hashString(`${prov}|${model || ""}|${system}|${firstUser}`)}`;
}

function connWeight(conn) {
  const w = Number.parseInt(conn?.weight, 10);
  return Number.isFinite(w) && w > 0 ? w : 1;
}

/**
 * Choose a connection for a conversation under weighted round-robin.
 *
 * @param {Array<object>} availableConnections - already filtered (no excluded/locked/whitelist-miss)
 *   and priority-sorted (ascending priority).
 * @param {string} providerId
 * @param {string} conversationKey
 * @returns {object|null} the chosen connection, or null if none available.
 */
export function pickConversationConnection(availableConnections, providerId, conversationKey) {
  if (!Array.isArray(availableConnections) || availableConnections.length === 0) return null;
  const now = Date.now();

  // 1. Sticky lookup — reuse the pinned connection if it's still available.
  if (conversationKey) {
    const assigned = conversationAssignments.get(conversationKey);
    if (assigned) {
      const pinned = availableConnections.find((c) => c.id === assigned.connectionId);
      if (pinned) {
        assigned.lastSeen = now;
        return pinned;
      }
      // Pinned connection no longer available (locked/excluded) — fall through to re-pin.
    }
  }

  // 2. Weighted round-robin pick over availableConnections (priority order preserved).
  const cursor = weightedCursor.get(providerId) || { connectionId: null, count: 0 };
  let idx = cursor.connectionId
    ? availableConnections.findIndex((c) => c.id === cursor.connectionId)
    : -1;

  let chosen;
  if (idx === -1) {
    // Current cursor connection is gone (or first ever) — start at the front.
    chosen = availableConnections[0];
    cursor.count = 1;
  } else {
    const current = availableConnections[idx];
    if (cursor.count < connWeight(current)) {
      // Stay on the current connection for another conversation.
      chosen = current;
      cursor.count += 1;
    } else {
      // Advance to the next connection (wrap around).
      const nextIdx = (idx + 1) % availableConnections.length;
      chosen = availableConnections[nextIdx];
      cursor.count = 1;
    }
  }

  cursor.connectionId = chosen.id;
  weightedCursor.set(providerId, cursor);

  if (conversationKey) {
    conversationAssignments.set(conversationKey, { connectionId: chosen.id, lastSeen: now });
    if (++setsSinceSweep >= SWEEP_EVERY) {
      setsSinceSweep = 0;
      sweepExpired(now);
    }
  }

  return chosen;
}

/**
 * Reset in-memory routing state when strategy/settings change.
 * @param {string} [providerId] - reset only this provider's cursor (+ its assignments); omit to clear all.
 */
export function resetConversationRouting(providerId) {
  if (providerId) {
    weightedCursor.delete(providerId);
    const prefix = `${providerId}:`;
    for (const key of conversationAssignments.keys()) {
      if (key.startsWith(prefix)) conversationAssignments.delete(key);
    }
  } else {
    weightedCursor.clear();
    conversationAssignments.clear();
  }
  setsSinceSweep = 0;
}
