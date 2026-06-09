// Move per-API-key access rules out of the kv table into a dedicated apiKeyRules
// table. Same JSON shape as before (providers/connections/models/combos arrays).
// Rows whose apiKeyId no longer exists in apiKeys are skipped (FK would reject).
export default {
  version: 3,
  name: "rules-table",
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS apiKeyRules (
        apiKeyId TEXT PRIMARY KEY REFERENCES apiKeys(id) ON DELETE CASCADE,
        rule TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `);

    const now = new Date().toISOString();
    const rows = db.all(
      `SELECT key, value FROM kv WHERE scope = 'apiKeyRules' AND key IN (SELECT id FROM apiKeys)`
    );
    for (const r of rows) {
      db.run(
        `INSERT INTO apiKeyRules(apiKeyId, rule, updatedAt) VALUES(?, ?, ?)
         ON CONFLICT(apiKeyId) DO UPDATE SET rule = excluded.rule, updatedAt = excluded.updatedAt`,
        [r.key, r.value, now]
      );
    }

    const allRulesCount = db.get(`SELECT COUNT(*) as c FROM kv WHERE scope = 'apiKeyRules'`)?.c ?? 0;
    const moved = rows.length;
    const skipped = allRulesCount - moved;
    if (skipped > 0) {
      console.warn(`[DB][migrate#3] skipped ${skipped} apiKeyRules rows whose apiKeyId no longer exists`);
    }

    db.run(`DELETE FROM kv WHERE scope = 'apiKeyRules'`);
    console.log(`[DB][migrate#3] moved ${moved} rule(s) from kv → apiKeyRules`);
  },
};
