import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

// Per-API-key access rules live in the kv table (same pattern as disabledModels).
// scope = "apiKeyRules", key = apiKeyId, value = JSON of the rule object.
const SCOPE = "apiKeyRules";

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
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, apiKeyId]);
  if (!row) return null;
  return normalizeRule(parseJson(row.value, {}));
}

export async function setRule(apiKeyId, rule) {
  const db = await getAdapter();
  const normalized = normalizeRule(rule);
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, apiKeyId, stringifyJson(normalized)]
  );
  return normalized;
}

export async function deleteRule(apiKeyId) {
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, apiKeyId]);
  return true;
}

export async function getAllRules() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = normalizeRule(parseJson(r.value, {}));
  return out;
}
