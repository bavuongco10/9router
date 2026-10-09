/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { getGitHubUsage } from "./usage/github.js";
import { getGeminiUsage, getAntigravityUsage } from "./usage/google.js";
import { getClaudeUsage, consumeClaudeResetGrant } from "./usage/claude.js";
import { getCodexUsage, consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits } from "./usage/codex.js";

export { consumeCodexRateLimitResetCredit, getCodexRateLimitResetCredits, consumeClaudeResetGrant };
import { getKiroUsage } from "./usage/kiro.js";
import { getMiniMaxUsage } from "./usage/minimax.js";
import { getMiniMaxCodeUsage } from "./minimaxCodeUsage.js";
import { getCodeBuddyCnUsage, getCodeBuddyIntlUsage } from "./usage/codebuddy-cn.js";
import { getGrokCliUsage } from "./usage/grok-cli.js";
import { getKimiUsage } from "./usage/kimi.js";
import { getDeepseekUsage } from "./usage/deepseek.js";
import { getOpenCodeGoUsage } from "./usage/opencode-go.js";
import { getOpenCodeZenUsage } from "./usage/opencode-zen.js";
import { getGroqUsage } from "./usage/groq.js";
import { getZedUsage } from "./usage/zed.js";
import { getXiaomiMimoUsage } from "./usage/xiaomi-mimo.js";
import { resolveQoderCredentials } from "./qoderModels.js";
import { getGlmUsage } from "./usage/glm.js";
import { getCommandCodeUsage } from "./usage/commandcode.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { parseResetTime } from "./usage/shared.js";
import {
  getIflowUsage,
  getOllamaUsage,
  getVercelAiGatewayUsage,
  getQoderUsage,
} from "./usage/misc.js";

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @returns {Object} Usage data with quotas
 */
// provider → usage handler (ctx carries every arg each handler needs)
const USAGE_HANDLERS = {
  github: (c) => getGitHubUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  "gemini-cli": (c) => getGeminiUsage(c.accessToken, c.providerDataWithProjectId, c.proxyOptions),
  antigravity: (c) => getAntigravityUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  claude: (c) => getClaudeUsage(c.accessToken, c.proxyOptions, { force: c.force }),
  codex: (c) => getCodexUsage(c.accessToken, c.proxyOptions),
  kiro: (c) => getKiroUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  qoder: (c) => getQoderUsageFor(c),
  "qoder-cn": (c) => getQoderUsageFor(c),
  iflow: (c) => getIflowUsage(c.accessToken),
  ollama: (c) => getOllamaUsage(c.apiKey, c.providerSpecificData, c.proxyOptions),
  // OAuth connections store the coding-plan key on accessToken (no apiKey)
  glm: (c) => getGlmUsage(c.apiKey || c.accessToken, c.provider, c.proxyOptions),
  "glm-cn": (c) => getGlmUsage(c.apiKey || c.accessToken, c.provider, c.proxyOptions),
  minimax: (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "minimax-cn": (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  // MiniMax Code (mcode) credits lane — signed account API + plan windows
  "minimax-code": (c) => getMiniMaxCodeUsage(c),
  "minimax-code-global": (c) => getMiniMaxCodeUsage(c),
  "vercel-ai-gateway": (c) => getVercelAiGatewayUsage(c.apiKey, c.proxyOptions),
  "codebuddy-cn": (c) => getCodeBuddyCnUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
  "codebuddy-intl": (c) => getCodeBuddyIntlUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
  "grok-cli": (c) => getGrokCliUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  kimi: (c) => getKimiUsage(c.accessToken, c.apiKey, c.proxyOptions, c.providerSpecificData),
  "opencode-go": (c) => getOpenCodeGoUsage(c.apiKey, c.proxyOptions),
  "opencode-zen": (c) => getOpenCodeZenUsage(c.apiKey, c.proxyOptions),
  deepseek: (c) => getDeepseekUsage(c.apiKey, c.proxyOptions),
  groq: (c) => getGroqUsage(c.apiKey, c.proxyOptions),
  zed: (c) => getZedUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  "xiaomi-mimo": (c) => getXiaomiMimoUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  commandcode: (c) => getCommandCodeUsage(c.apiKey, c.proxyOptions),
};

// Qoder intl/CN share one usage path: PATs must be exchanged to a job token
// before the quota endpoint accepts them, and the quota URL comes from the
// provider's own registry usage block (region-correct via c.provider).
async function getQoderUsageFor(c) {
  const resolved = await resolveQoderCredentials(c, c.proxyOptions).catch(() => null);
  return getQoderUsage(resolved?.accessToken || c.accessToken, c.proxyOptions, c.provider || "qoder");
}

export async function getUsageForProvider(connection, proxyOptions = null, options = {}) {
  const { provider, accessToken, apiKey, providerSpecificData, projectId } = connection;
  const providerDataWithProjectId = {
    ...(providerSpecificData || {}),
    ...(projectId ? { projectId } : {}),
  };

  if (providerSpecificData?.quotaShareUrl) {
    return getShareLinkUsage(providerSpecificData.quotaShareUrl, proxyOptions);
  }

  const handler = USAGE_HANDLERS[provider];
  if (!handler) return { message: `Usage API not implemented for ${provider}` };
  return await handler({
    provider,
    accessToken,
    apiKey,
    providerSpecificData,
    providerDataWithProjectId,
    proxyOptions,
    force: options.force === true,
  });
}

// Custom providers (e.g. UQ Router) that publish a quota share link
// `<host>/share/c/<token>`; its page reads JSON from `<host>/api/public/connections/<token>`
// → { plan, tierLabel, windows: [{ name, pct (% used), resetAt, unlimited }] }.
// ponytail: only this share-link shape is supported; add a per-format adapter if another host differs.
export const QUOTA_SHARE_URL_RE = /^https?:\/\/.+\/share\/c\/[^/]+$/;

async function getShareLinkUsage(shareUrl, proxyOptions) {
  const apiUrl = shareUrl.replace("/share/c/", "/api/public/connections/");
  const res = await proxyAwareFetch(apiUrl, { cache: "no-store" }, proxyOptions);
  if (!res.ok) return { message: `Quota share link returned ${res.status}` };
  const data = await res.json();
  const quotas = {};
  for (const w of data.windows || []) {
    const remaining = Math.max(0, 100 - (w.pct ?? 0));
    quotas[w.name] = {
      used: w.pct ?? 0,
      total: 100,
      remaining,
      remainingPercentage: remaining,
      resetAt: parseResetTime(w.resetAt),
      unlimited: !!w.unlimited,
    };
  }
  return { plan: data.plan || null, tier: data.tierLabel || null, quotas };
}
