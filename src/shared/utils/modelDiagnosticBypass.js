import { randomUUID } from "node:crypto";

export const MODEL_WHITELIST_BYPASS_HEADER = "x-9r-bypass-model-whitelist";
export const MODEL_WHITELIST_BYPASS_VALUE = "diagnostic-model-test";
export const MODEL_WHITELIST_BYPASS_NONCE_HEADER = "x-9r-bypass-model-whitelist-nonce";

const NONCE_TTL_MS = 30_000;
const MAX_NONCES = 1000;
const STORE_KEY = Symbol.for("9router.modelDiagnosticBypassNonces");

function getStore() {
  if (!globalThis[STORE_KEY]) globalThis[STORE_KEY] = new Map();
  return globalThis[STORE_KEY];
}

function pruneExpiredNonces(store, now) {
  for (const [nonce, expiresAt] of store) {
    if (expiresAt <= now || store.size > MAX_NONCES) store.delete(nonce);
  }
}

export function createModelWhitelistBypassNonce() {
  const store = getStore();
  const now = Date.now();
  pruneExpiredNonces(store, now);
  const nonce = randomUUID();
  store.set(nonce, now + NONCE_TTL_MS);
  return nonce;
}

export function consumeModelWhitelistBypassNonce(nonce) {
  if (!nonce) return false;
  const store = getStore();
  const now = Date.now();
  pruneExpiredNonces(store, now);
  const expiresAt = store.get(nonce);
  if (!expiresAt) return false;
  store.delete(nonce);
  return expiresAt > now;
}
