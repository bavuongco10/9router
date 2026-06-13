// Rebuild the `usageDaily` aggregate cache from scratch out of `usageHistory`.
//
// `usageDaily` is a DERIVED cache that the dashboard's analytics read as the
// source of truth (see usageRepo.getUsageStats). It is normally maintained
// incrementally on each saveRequestUsage(), so any out-of-band edit to
// `usageHistory` (e.g. the expose→source migration) leaves it stale. This
// replays every history row through the SAME aggregation used live and emits
// SQL to replace usageDaily.
//
// Pure JS — no native deps — so it runs with plain host node. MUST run with
// TZ=UTC to match the container (getLocalDateKey buckets in the process TZ):
//
//   sqlite3 -json data.sqlite \
//     "SELECT timestamp,provider,model,connectionId,apiKey,endpoint,cost,tokens \
//      FROM usageHistory ORDER BY id ASC" > /tmp/uh.json
//   TZ=UTC node scripts/rebuild-usage-daily.mjs /tmp/uh.json > /tmp/rebuild.sql
//   # inspect, then: sqlite3 data.sqlite < /tmp/rebuild.sql
//
// The aggregation below is copied verbatim from usageRepo.js so the rebuilt
// day objects are byte-for-byte what the live path would have produced.

import fs from "node:fs";

// --- verbatim from usageRepo.js ---
function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}
// --- end verbatim ---

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: TZ=UTC node rebuild-usage-daily.mjs <usageHistory.json>");
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
const days = {};
for (const r of rows) {
  let tokens = {};
  if (r.tokens) {
    try { tokens = typeof r.tokens === "string" ? JSON.parse(r.tokens) : r.tokens; } catch { tokens = {}; }
  }
  const entry = {
    provider: r.provider,
    model: r.model,
    connectionId: r.connectionId,
    apiKey: r.apiKey,
    endpoint: r.endpoint,
    cost: r.cost || 0,
    tokens,
  };
  const key = getLocalDateKey(r.timestamp);
  days[key] ||= {};
  aggregateEntryToDay(days[key], entry);
}

// Verification mode: emit the rebuilt {dateKey: dayObj} map as JSON so it can be
// diffed against the existing usageDaily before trusting the rebuild.
if (process.env.REBUILD_EMIT === "json") {
  process.stdout.write(JSON.stringify(days));
  console.error(`[rebuild] (json mode) ${rows.length} rows → ${Object.keys(days).length} days`);
  process.exit(0);
}

function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

const out = [];
out.push("BEGIN;");
out.push("DELETE FROM usageDaily;");
for (const [dateKey, day] of Object.entries(days)) {
  out.push(`INSERT INTO usageDaily(dateKey, data) VALUES(${sqlStr(dateKey)}, ${sqlStr(JSON.stringify(day))});`);
}
out.push("COMMIT;");
process.stdout.write(out.join("\n") + "\n");

console.error(`[rebuild] ${rows.length} history rows → ${Object.keys(days).length} day buckets`);
