// Upstream per-key access control: add apiKeys.accessRestricted / accessAllow.
// Existing rows read as unrestricted (0).
const NEW_COLUMNS = {
  accessRestricted: "INTEGER DEFAULT 0",
  accessAllow: "TEXT",
};

export default {
  version: 4,
  name: "apikey-access-cols",
  up(db) {
    // Guarded — syncSchema may have added them already.
    for (const [col, type] of Object.entries(NEW_COLUMNS)) {
      try {
        db.exec(`ALTER TABLE apiKeys ADD COLUMN ${col} ${type}`);
      } catch (e) {
        if (!/duplicate column/i.test(e?.message || "")) throw e;
      }
    }
  },
};
