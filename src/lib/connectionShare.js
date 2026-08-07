// Shared shape for copying a provider connection (tokens and all) between
// 9router instances. `toExportableConnection` produces the JSON blob the Copy
// button puts on the clipboard; `sanitizeImportedConnection` cleans a pasted
// blob before it goes through the WAL-safe createProviderConnection path.

// Instance-local / runtime fields that must NOT travel: they belong to the
// source instance (ids, ordering) or are health state the recipient re-derives.
const STRIP_FIELDS = new Set([
  "id", "priority", "globalPriority", "createdAt", "updatedAt",
  "testStatus", "lastTested", "lastError", "lastErrorAt", "lastErrorType",
  "errorCode", "rateLimitedUntil", "consecutiveUseCount", "lastRefreshAt",
]);

// Proxy binding in providerSpecificData points at the SOURCE instance's proxy
// pools; carrying it could silently route the recipient's traffic through a
// proxy they never configured.
const STRIP_PROVIDER_SPECIFIC = ["proxyPoolId", "connectionProxyEnabled", "connectionProxyUrl", "connectionNoProxy"];

const CREDENTIAL_FIELDS = ["refreshToken", "accessToken", "idToken", "apiKey", "cookie", "l"];

function stripInstanceFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (STRIP_FIELDS.has(k)) continue;
    if (k.startsWith("modelLock_")) continue;
    out[k] = v;
  }
  if (out.providerSpecificData && typeof out.providerSpecificData === "object") {
    const psd = { ...out.providerSpecificData };
    for (const k of STRIP_PROVIDER_SPECIFIC) delete psd[k];
    out.providerSpecificData = psd;
  }
  return out;
}

// Full connection minus instance-local fields — provider-agnostic, keeps every
// credential/token and providerSpecificData so the recipient's copy just works.
export function toExportableConnection(conn) {
  if (!conn || typeof conn !== "object") return null;
  return stripInstanceFields(conn);
}

function hasCredential(obj) {
  return CREDENTIAL_FIELDS.some((f) => obj[f] != null && obj[f] !== "");
}

// Clean a pasted blob for createProviderConnection. Throws on unusable input so
// the import route can surface a 400 (never a silent bad insert).
export function sanitizeImportedConnection(blob) {
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) {
    throw new Error("Connection data must be a JSON object");
  }
  const clean = stripInstanceFields(blob);
  if (!clean.provider || typeof clean.provider !== "string") {
    throw new Error("Missing provider");
  }
  if (!hasCredential(clean)) {
    throw new Error("No credential found (need refreshToken, accessToken, apiKey, or cookie)");
  }
  return clean;
}
