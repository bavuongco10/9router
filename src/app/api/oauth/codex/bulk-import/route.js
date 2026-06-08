import { NextResponse } from "next/server";
import { createProviderConnection } from "@/models";
import { extractCodexAccountInfo } from "@/lib/oauth/providers";

// Coerce a timestamp-ish value (ISO string, epoch seconds, or epoch ms) to ISO.
// Returns undefined for empty/unparseable input.
function toIso(val) {
  if (val == null || val === "") return undefined;
  if (typeof val === "number" || (typeof val === "string" && /^\d+$/.test(val.trim()))) {
    let n = Number(val);
    if (n > 0 && n < 1e12) n *= 1000; // looks like epoch seconds -> ms
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// Map the alternate snake_case export format onto the internal camelCase shape.
// Current camelCase payloads pass through unchanged (their keys hit the default
// branch). Empty strings are treated as absent so they don't clobber
// JWT-backfilled values or trip the accessToken validation.
function normalizeCodexAccount(raw) {
  const out = {};
  const psd = {};
  for (const [key, value] of Object.entries(raw)) {
    const v = typeof value === "string" && value.trim() === "" ? undefined : value;
    if (v === undefined) continue;
    switch (key) {
      case "access_token": out.accessToken = v; break;
      case "refresh_token": out.refreshToken = v; break;
      case "id_token": out.idToken = v; break;
      case "last_refresh": out.lastRefreshAt = toIso(v); break;
      case "expired": out.expiresAt = toIso(v); break;
      case "account_id": psd.chatgptAccountId = v; break;
      case "oai_password": psd.oaiPassword = v; break;
      case "outlook_email": psd.outlookEmail = v; break;
      case "type": break; // provider is forced to "codex" below
      default: out[key] = v; // pass through camelCase + any unknown keys
    }
  }
  // Fold snake_case extras into providerSpecificData; an explicitly-provided
  // camelCase providerSpecificData wins on key conflicts.
  if (Object.keys(psd).length > 0) {
    out.providerSpecificData = { ...psd, ...(out.providerSpecificData || {}) };
  }
  return out;
}

/**
 * POST /api/oauth/codex/bulk-import
 * Bulk import multiple codex (OAuth) account JSON objects in one call.
 *
 * Body accepts any of:
 *   - Array:    [{...}, {...}]
 *   - Single:   {...}
 *   - Wrapped:  { accounts: [{...}, ...] }
 *
 * Each item must contain at least `accessToken`. Missing email / chatgpt
 * account info is best-effort backfilled from the JWT (idToken or accessToken).
 *
 * Tokens are NEVER echoed back in the response.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${err.message}` },
      { status: 400 }
    );
  }

  // Normalize to array
  let accounts;
  if (Array.isArray(body)) {
    accounts = body;
  } else if (body && typeof body === "object" && Array.isArray(body.accounts)) {
    accounts = body.accounts;
  } else if (body && typeof body === "object") {
    accounts = [body];
  } else {
    accounts = null;
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json(
      { error: "No accounts provided" },
      { status: 400 }
    );
  }

  const results = [];
  let success = 0;
  let failed = 0;

  // SERIAL loop — createProviderConnection reads max(priority) and reorders
  // inside a transaction. Parallel calls would race on priority assignment.
  for (let i = 0; i < accounts.length; i++) {
    const raw = accounts[i];
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Item is not an object");
      }

      // Strip server-controlled fields
      const {
        id: _id,
        provider: _provider,
        authType: _authType,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        ...rest
      } = raw;

      // Accept both the camelCase shape and the snake_case export format.
      const item = normalizeCodexAccount(rest);

      if (!item.accessToken || typeof item.accessToken !== "string") {
        throw new Error("Missing accessToken");
      }

      // Backfill missing identity fields from JWT claims
      const psd = item.providerSpecificData || {};
      const needsEmail = !item.email;
      const needsAccountId = !psd.chatgptAccountId;
      const needsPlanType = !psd.chatgptPlanType;

      if (needsEmail || needsAccountId || needsPlanType) {
        const info = extractCodexAccountInfo(item.idToken || item.accessToken) || {};
        if (needsEmail && info.email) item.email = info.email;
        if (needsAccountId && info.chatgptAccountId) {
          psd.chatgptAccountId = info.chatgptAccountId;
        }
        if (needsPlanType && info.chatgptPlanType) {
          psd.chatgptPlanType = info.chatgptPlanType;
        }
      }
      if (Object.keys(psd).length > 0) {
        item.providerSpecificData = psd;
      }

      // Compute expiresAt from expiresIn if absent
      if (!item.expiresAt && typeof item.expiresIn === "number" && item.expiresIn > 0) {
        item.expiresAt = new Date(Date.now() + item.expiresIn * 1000).toISOString();
      }

      // Defaults aligned with OAuth-completed flow
      if (item.testStatus === undefined) item.testStatus = "active";
      if (item.isActive === undefined) item.isActive = true;
      if (!item.lastRefreshAt) item.lastRefreshAt = new Date().toISOString();

      const created = await createProviderConnection({
        provider: "codex",
        authType: "oauth",
        ...item,
      });

      results.push({ index: i, ok: true, id: created.id });
      success++;
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message || "Unknown error" });
      failed++;
    }
  }

  return NextResponse.json({ success, failed, results });
}
