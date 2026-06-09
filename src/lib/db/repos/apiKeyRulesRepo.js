import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Per-API-key access rules live in the dedicated apiKeyRules table
// (migration 003 moved them out of kv). Same JSON shape: each dimension is
// an array of strings; "*" means ALL.
const DIMENSIONS = ["providers", "connections", "models", "combos"];

// Coerce any stored/incoming value into a clean rule: each dimension an array of
// non-empty strings. An array may contain the wildcard "*" meaning ALL.
export function normalizeRule(rule) {
  const out = {};
  for (const dim of DIMENSIONS) {
    const arr = rule && Array.isArray(rule[dim]) ? rule[dim] : [];
    out[dim] = [...new Set(arr.filter((x) => typeof x === "string" && x.length > 0))];
  }
  return out;
}

export async function getRule(apiKeyId) {
  const db = await getAdapter();
  const row = db.get(`SELECT rule FROM apiKeyRules WHERE apiKeyId = ?`, [apiKeyId]);
  if (!row) return null;
  return normalizeRule(parseJson(row.rule, {}));
}

export async function setRule(apiKeyId, rule) {
  const db = await getAdapter();
  const normalized = normalizeRule(rule);
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO apiKeyRules(apiKeyId, rule, updatedAt) VALUES(?, ?, ?)
     ON CONFLICT(apiKeyId) DO UPDATE SET rule = excluded.rule, updatedAt = excluded.updatedAt`,
    [apiKeyId, stringifyJson(normalized), now]
  );
  return normalized;
}

export async function deleteRule(apiKeyId) {
  const db = await getAdapter();
  db.run(`DELETE FROM apiKeyRules WHERE apiKeyId = ?`, [apiKeyId]);
  return true;
}

export async function getAllRules() {
  const db = await getAdapter();
  const rows = db.all(`SELECT apiKeyId, rule FROM apiKeyRules`);
  const out = {};
  for (const r of rows) out[r.apiKeyId] = normalizeRule(parseJson(r.rule, {}));
  return out;
}
