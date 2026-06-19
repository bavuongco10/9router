/**
 * Claude usage handler
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { ANTHROPIC_API_VERSION } from "../../providers/shared.js";
import { U, parseResetTime } from "./shared.js";

// Claude API config (urls from registry, apiVersion is header logic kept here)
const CLAUDE_CONFIG = {
  oauthUsageUrl: U("claude").oauthUrl,
  profileUrl: U("claude").profileUrl,
  usageUrl: U("claude").orgUrl,
  settingsUrl: U("claude").settingsUrl,
  apiVersion: ANTHROPIC_API_VERSION,
};

// Derive the Claude account tier label from the OAuth profile.
// Authoritative source: organization.organization_type + organization.rate_limit_tier
// (same fields Claude Code CLI reads). Falls back to has_claude_max/has_claude_pro
// on API-key profiles when no organization type is present.
function detectClaudeTier(profile) {
  if (!profile || typeof profile !== "object") return null;

  const org = profile.organization || {};
  const orgType = (org.organization_type || "").toLowerCase();
  const rateTier = (org.rate_limit_tier || "").toLowerCase();

  switch (orgType) {
    case "claude_max":
      return rateTier.includes("20x") ? "Max 20×" : "Max 5×";
    case "claude_pro":
      return "Pro";
    case "claude_team":
      return rateTier.includes("5x") ? "Team Premium" : "Team";
    case "claude_enterprise":
      return "Enterprise";
    default:
      break;
  }

  if (profile.has_claude_max) return "Max";
  if (profile.has_claude_pro) return "Pro";

  return null;
}

async function getClaudeTier(accessToken, proxyOptions = null) {
  try {
    const response = await proxyAwareFetch(CLAUDE_CONFIG.profileUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (!response.ok) return null;
    const profile = await response.json();
    return detectClaudeTier(profile);
  } catch (error) {
    console.warn(`[Claude Profile] Unable to fetch tier: ${error.message}`);
    return null;
  }
}

// OAuth usage endpoint rate-limits (429); cool down per-token to stop hammering it.
// Only the quota endpoint is affected — chat with the same token still works.
const OAUTH_429_COOLDOWN_MS = 180000;
const oauthCooldown = new Map();

export async function getClaudeUsage(accessToken, proxyOptions = null) {
  try {
    // Skip OAuth usage call while this token is cooling down from a recent 429.
    // Tier is still fetched best-effort so the badge stays visible.
    const cooldownUntil = oauthCooldown.get(accessToken);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      const [legacy, tier] = await Promise.all([
        getClaudeUsageLegacy(accessToken, proxyOptions),
        getClaudeTier(accessToken, proxyOptions),
      ]);
      return tier ? { ...legacy, tier } : legacy;
    }

    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens).
    // Fetch usage + account tier in parallel (tier is best-effort).
    const [oauthResponse, tier] = await Promise.all([
      proxyAwareFetch(CLAUDE_CONFIG.oauthUsageUrl, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-version": CLAUDE_CONFIG.apiVersion,
        },
      }, proxyOptions),
      getClaudeTier(accessToken, proxyOptions),
    ]);

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && typeof window.utilization === "number";

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      return {
        plan: "Claude Code",
        tier,
        extraUsage: data.extra_usage ?? null,
        quotas,
      };
    }

    // Cool down OAuth usage polling after a 429 (quota endpoint only)
    if (oauthResponse.status === 429) {
      oauthCooldown.set(accessToken, Date.now() + OAUTH_429_COOLDOWN_MS);
    }

    // Fallback: legacy settings + org usage endpoint
    console.warn(`[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`);
    const legacy = await getClaudeUsageLegacy(accessToken, proxyOptions);
    return tier ? { ...legacy, tier } : legacy;
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken, proxyOptions = null) {
  try {
    const settingsResponse = await proxyAwareFetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await proxyAwareFetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          },
          proxyOptions
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}
