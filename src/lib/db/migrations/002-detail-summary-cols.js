// Add lightweight summary columns to requestDetails and backfill them from the
// existing heavy `data` JSON, so the list/analytics can stop parsing `data`.
// Existing rows keep their heavy `data` (used as the detail-drawer fallback).
import { parseJson } from "../helpers/jsonCol.js";

const NEW_COLUMNS = {
  inputTokens: "INTEGER",
  outputTokens: "INTEGER",
  latencyTotal: "INTEGER",
  latencyTtft: "INTEGER",
};

function rowInputTokens(tokens) {
  const prompt = tokens?.prompt_tokens || tokens?.input_tokens || 0;
  const cache = tokens?.cached_tokens || tokens?.cache_read_input_tokens || 0;
  return prompt < cache ? cache : prompt;
}

export default {
  version: 2,
  name: "detail-summary-cols",
  up(db) {
    // Add columns (guarded — syncSchema or a re-run may have added them).
    for (const [col, type] of Object.entries(NEW_COLUMNS)) {
      try {
        db.exec(`ALTER TABLE requestDetails ADD COLUMN ${col} ${type}`);
      } catch (e) {
        if (!/duplicate column/i.test(e?.message || "")) throw e;
      }
    }

    // Backfill from the heavy `data` blob (bounded — old cap was ~1000 rows).
    const rows = db.all(`SELECT id, data FROM requestDetails WHERE inputTokens IS NULL`);
    for (const r of rows) {
      const d = parseJson(r.data, {});
      const t = d?.tokens || {};
      db.run(
        `UPDATE requestDetails SET inputTokens = ?, outputTokens = ?, latencyTotal = ?, latencyTtft = ? WHERE id = ?`,
        [
          rowInputTokens(t),
          t.completion_tokens || t.output_tokens || 0,
          d?.latency?.total || 0,
          d?.latency?.ttft || 0,
          r.id,
        ]
      );
    }
  },
};
