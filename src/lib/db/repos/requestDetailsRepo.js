import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { writePayload, readPayload } from "./requestPayloadStore.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const envEnabled = process.env.OBSERVABILITY_ENABLED !== "false";
    const enabled = typeof settings.enableObservability === "boolean"
      ? settings.enableObservability
      : envEnabled;
    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

// Build the light summary (kept in the `data` column as the drawer fallback)
// and the full detail (offloaded, gzipped, to disk).
function prepareRecord(item) {
  if (!item.id) item.id = generateDetailId(item.model);
  if (!item.timestamp) item.timestamp = new Date().toISOString();
  if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

  const tokens = item.tokens || {};
  const latency = item.latency || {};

  const summary = {
    id: item.id,
    timestamp: item.timestamp,
    provider: item.provider || null,
    model: item.model || null,
    connectionId: item.connectionId || null,
    status: item.status || null,
    latency,
    tokens,
  };

  // Full (untruncated) bodies live in the offloaded file only.
  const fullDetail = {
    ...summary,
    request: item.request ?? null,
    providerRequest: item.providerRequest ?? null,
    providerResponse: item.providerResponse ?? null,
    response: item.response ?? null,
  };

  return {
    id: item.id,
    timestamp: item.timestamp,
    provider: summary.provider,
    model: summary.model,
    connectionId: summary.connectionId,
    status: summary.status,
    inputTokens: rowInputTokens(tokens),
    outputTokens: tokens.completion_tokens || tokens.output_tokens || 0,
    latencyTotal: latency.total || 0,
    latencyTtft: latency.ttft || 0,
    summary,
    fullDetail,
  };
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();

      const prepared = items.map(prepareRecord);

      db.transaction(() => {
        for (const p of prepared) {
          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, inputTokens, outputTokens, latencyTotal, latencyTtft, data)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, inputTokens = excluded.inputTokens, outputTokens = excluded.outputTokens, latencyTotal = excluded.latencyTotal, latencyTtft = excluded.latencyTtft, data = excluded.data`,
            [p.id, p.timestamp, p.provider, p.model, p.connectionId, p.status, p.inputTokens, p.outputTokens, p.latencyTotal, p.latencyTtft, stringifyJson(p.summary)]
          );
        }
        // No record cap: summary rows are tiny and intentionally uncapped.
        // Heavy payloads are size-capped separately in requestPayloadStore.
      });

      // Offload heavy payloads to disk (gzip) outside the DB transaction.
      for (const p of prepared) {
        writePayload(p.id, p.timestamp, p.fullDetail).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

function buildDetailWhere(filter = {}) {
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  // "failed" = any status that is not "success" (covers "failed", "error", NULL, ...).
  if (filter.status === "success") { conds.push("status = ?"); params.push("success"); }
  else if (filter.status === "failed") { conds.push("(status IS NULL OR status <> ?)"); params.push("success"); }
  else if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const { where, params } = buildDetailWhere(filter);

  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  // Columns only — never touch the heavy payload. The shape mirrors the old
  // detail object closely enough that the table renders unchanged.
  const rows = db.all(
    `SELECT id, timestamp, provider, model, connectionId, status, inputTokens, outputTokens, latencyTotal, latencyTtft
     FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    provider: r.provider,
    model: r.model,
    connectionId: r.connectionId,
    status: r.status,
    tokens: { prompt_tokens: r.inputTokens || 0, completion_tokens: r.outputTokens || 0 },
    latency: { ttft: r.latencyTtft || 0, total: r.latencyTotal || 0 },
  }));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

// Full detail for the drawer. Heavy bodies come from the offloaded gzip file;
// if it was evicted (or this is a pre-migration row), fall back to the light
// summary stored in the `data` column.
export async function getRequestDetailById(id) {
  const fromFile = await readPayload(id);
  if (fromFile) return fromFile;

  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  if (!row) return null;
  const fallback = parseJson(row.data, null);
  if (fallback && typeof fallback === "object") {
    // Pre-migration rows still carry full bodies in `data`; new rows store only
    // the light summary, so missing bodies means the payload was evicted.
    const hasBodies = !!(fallback.request || fallback.response || fallback.providerRequest || fallback.providerResponse);
    if (!hasBodies) fallback.payloadEvicted = true;
  }
  return fallback;
}

function rowInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  const cache = tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
  return prompt < cache ? cache : prompt;
}

// SQL expression that buckets the ISO timestamp by the requested granularity.
// hour/day/month are pure substrings (robust); week uses strftime on a
// space-separated, millisecond-stripped copy so SQLite parses it reliably.
function timeBucketExpr(groupBy) {
  switch (groupBy) {
    case "hour":  return "substr(timestamp, 1, 13)"; // 2026-06-08T19
    case "week":  return "strftime('%Y-W%W', replace(substr(timestamp, 1, 19), 'T', ' '))"; // 2026-W23
    case "month": return "substr(timestamp, 1, 7)";  // 2026-06
    case "day":
    default:      return "substr(timestamp, 1, 10)"; // 2026-06-08
  }
}

// Aggregated over ALL filtered rows via pure SQL on the summary columns — no
// JSON parsing, no loading rows into JS, so it scales to unlimited records.
export async function getRequestDetailsStats(filter = {}) {
  const db = await getAdapter();
  const { where, params } = buildDetailWhere(filter);

  const totals = db.get(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
       COALESCE(SUM(inputTokens), 0) AS totalInputTokens,
       COALESCE(SUM(outputTokens), 0) AS totalOutputTokens,
       COALESCE(AVG(CASE WHEN latencyTotal > 0 THEN latencyTotal END), 0) AS avgLatency
     FROM requestDetails ${where}`,
    params
  ) || {};

  const total = totals.total || 0;
  const success = totals.success || 0;
  const failed = total - success;

  const series = db.all(
    `SELECT ${timeBucketExpr(filter.groupBy)} AS date,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success
     FROM requestDetails ${where}
     GROUP BY date ORDER BY date ASC`,
    params
  ).map((r) => {
    const failed = r.total - r.success;
    // failRate (%) is the highlight metric: visible even when failed counts are
    // tiny next to total/success. One decimal of precision.
    const failRate = r.total ? Math.round((failed / r.total) * 1000) / 10 : 0;
    return { date: r.date, total: r.total, success: r.success, failed, failRate };
  });

  const byProvider = db.all(
    `SELECT COALESCE(provider, 'unknown') AS provider, COUNT(*) AS total
     FROM requestDetails ${where}
     GROUP BY provider ORDER BY total DESC`,
    params
  );

  return {
    total,
    success,
    failed,
    successRate: total ? Math.round((success / total) * 100) : 0,
    avgLatencyMs: Math.round(totals.avgLatency || 0),
    totalOutputTokens: totals.totalOutputTokens || 0,
    totalInputTokens: totals.totalInputTokens || 0,
    groupBy: filter.groupBy || "day",
    series,
    byProvider,
  };
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
