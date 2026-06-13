import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection, getProviderConnections } from "@/models";

const MAX_ACCOUNTS = 200;

/**
 * POST /api/oauth/kiro/import-json
 *
 * Accepts a JSON object or array of Kiro account exports (the format produced
 * by the Kiro-Import-9Router helper script) and creates a providerConnection
 * for each. Goes through the running server (not direct sqlite writes), so
 * WAL safety is preserved.
 *
 * Account shape (per item):
 *   { type?: "kiro", access_token, refresh_token, email?,
 *     expires_in?, profile_arn?, region?, auth_method?,
 *     client_id?, client_secret? }
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Accept either a single account or an array. Also accept { accounts: [...] }
  // for callers that wrap the array.
  let accounts;
  if (Array.isArray(body)) accounts = body;
  else if (Array.isArray(body?.accounts)) accounts = body.accounts;
  else if (body && typeof body === "object") accounts = [body];
  else accounts = [];

  // Filter to plausible Kiro entries (must at least carry a refresh_token).
  accounts = accounts.filter(a => a && a.refresh_token);

  if (accounts.length === 0) {
    return NextResponse.json(
      { error: "No Kiro accounts found in JSON (each entry needs refresh_token)" },
      { status: 400 }
    );
  }

  if (accounts.length > MAX_ACCOUNTS) {
    return NextResponse.json(
      { error: `Too many accounts in one request (max ${MAX_ACCOUNTS})` },
      { status: 413 }
    );
  }

  // Opt-in to overwrite existing connections that match by email. Default is
  // to skip — without this, a same-email entry would silently clobber the
  // stored access/refresh tokens via createProviderConnection's email dedupe.
  const overwriteByEmail = body?.overwrite === true;

  const kiroService = new KiroService();

  // Build a quick lookup of existing kiro connections so we can skip dupes
  // before hitting createProviderConnection (which dedupes by email and would
  // otherwise overwrite tokens when an attacker-supplied entry shares an
  // existing email — token-takeover risk).
  const existing = await getProviderConnections("kiro");
  const existingRefresh = new Set(
    existing.map(c => c?.refreshToken).filter(Boolean)
  );
  const existingEmails = new Set(
    existing.map(c => (c?.email || "").trim().toLowerCase()).filter(Boolean)
  );

  const results = [];
  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const label = acc.email || `account-${i + 1}`;

    if (existingRefresh.has(acc.refresh_token)) {
      results.push({ index: i, email: acc.email || null, status: "skipped" });
      skipped++;
      continue;
    }

    // Mirror the script: don't validate (tokens may already be near-expiry);
    // store as-is with expiresAt=now so 9Router refreshes on first use.
    const now = new Date();
    const expiresIn = Number(acc.expires_in) || 3600;

    // Best-effort email extraction from JWT if not provided.
    let email = acc.email || null;
    if (!email && acc.access_token) {
      try {
        email = kiroService.extractEmailFromJWT(acc.access_token);
      } catch {}
    }

    // Email-collision guard: createProviderConnection merges by email and
    // would overwrite the stored tokens. Skip unless caller opted into
    // overwrite. Use a non-distinguishing "skipped" reason so the response
    // doesn't double as a "is this email/token present" oracle.
    const emailKey = (email || "").trim().toLowerCase();
    if (emailKey && existingEmails.has(emailKey) && !overwriteByEmail) {
      results.push({ index: i, email, status: "skipped" });
      skipped++;
      continue;
    }

    try {
      const connection = await createProviderConnection({
        provider: "kiro",
        authType: "oauth",
        accessToken: acc.access_token,
        refreshToken: acc.refresh_token,
        expiresAt: now.toISOString(),
        email,
        providerSpecificData: {
          profileArn: acc.profile_arn || "",
          region: acc.region || "us-east-1",
          authMethod: acc.auth_method || "imported",
          clientId: acc.client_id || "",
          clientSecret: acc.client_secret || "",
          provider: "Imported (JSON)",
        },
        testStatus: "active",
      });

      // Remember this refresh token so subsequent items in the same batch
      // don't double-insert if the user pasted the same account twice.
      existingRefresh.add(acc.refresh_token);

      results.push({
        index: i,
        email: connection.email || email,
        status: "added",
        id: connection.id,
      });
      added++;
    } catch (err) {
      console.log(`Kiro JSON import failed for ${label}:`, err);
      results.push({
        index: i,
        email,
        status: "failed",
        error: "Failed to create connection",
      });
      failed++;
    }
  }

  return NextResponse.json({
    success: added > 0,
    summary: { added, skipped, failed, total: accounts.length },
    results,
  });
}
