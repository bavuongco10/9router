// Pure access-control evaluation for per-API-key rules. No DB imports.
//
// A rule = { providers:[], connections:[], models:[], combos:[] } where each
// array holds string ids and may contain the wildcard "*" (= ALL of that
// dimension). Semantics are DEFAULT-DENY + UNION: a key with no rule (or an
// empty rule) can access nothing; access is granted if ANY dimension grants it.
import { resolveProviderId } from "@/shared/constants/providers";

const WILDCARD = "*";

export function ruleGrantsAnything(rule) {
  if (!rule || typeof rule !== "object") return false;
  return (
    (rule.providers?.length || 0) +
    (rule.connections?.length || 0) +
    (rule.models?.length || 0) +
    (rule.combos?.length || 0)
  ) > 0;
}

function comboModelList(combo) {
  let models = combo?.models;
  if (typeof models === "string") {
    try { models = JSON.parse(models); } catch { models = []; }
  }
  return Array.isArray(models) ? models : [];
}

// Expand the combos granted by a rule into a Set of member model ids.
export function expandComboModels(rule, allCombos) {
  const set = new Set();
  if (!rule || !Array.isArray(rule.combos) || rule.combos.length === 0) return set;
  const combos = Array.isArray(allCombos) ? allCombos : [];
  const all = rule.combos.includes(WILDCARD);
  for (const combo of combos) {
    if (all || rule.combos.includes(combo.name)) {
      for (const m of comboModelList(combo)) set.add(m);
    }
  }
  return set;
}

// Single resolved request check. modelId = full "alias/model" id; bareModel =
// the upstream model id; provider = canonical provider id; connectionId chosen.
// `candidateIds` lets the caller pass any number of additional id forms (e.g.
// the client's original modelStr) — useful when the listing id has a custom
// shape that differs from `${alias}/${model}` (kiro/qoder etc).
export function isModelAllowedForKey({ rule, provider, modelId, bareModel, connectionId, combos, candidateIds }) {
  if (!rule || !ruleGrantsAnything(rule)) return false;

  const providers = rule.providers || [];
  if (providers.includes(WILDCARD) || providers.includes(provider)) return true;

  const connections = rule.connections || [];
  if (connectionId && (connections.includes(WILDCARD) || connections.includes(connectionId))) return true;

  // Build the full set of model-id candidates we'll match against rule.models
  // and the combo-expanded set.
  const ids = [];
  if (modelId) ids.push(modelId);
  if (bareModel) ids.push(bareModel);
  if (Array.isArray(candidateIds)) for (const c of candidateIds) if (c) ids.push(c);

  const models = rule.models || [];
  if (models.includes(WILDCARD)) return true;
  for (const id of ids) if (models.includes(id)) return true;

  // Combo membership match. The same upstream model can appear in a combo
  // under different listing prefixes (e.g. "uq/kiro/x" vs "kiro/x"); accept any
  // member whose trailing segment is `bareModel` AND whose path contains the
  // resolved `provider` id.
  const comboModels = expandComboModels(rule, combos || []);
  for (const m of comboModels) {
    if (ids.includes(m)) return true;
    if (!bareModel) continue;
    if (m === bareModel) return true;
    if (m.endsWith(`/${bareModel}`) && m.split("/").includes(provider)) return true;
  }

  return false;
}

// Filter the /v1/models listing to a key's allowed set. `models` entries look
// like { id, owned_by, ... }; combo entries have owned_by === "combo" and
// id === comboName. Default-deny: no rule -> empty list.
//
// Combo grants are intentionally NOT expanded into member models in the
// listing — granting a combo shows only the combo entry, not its members.
// Request-time enforcement still expands combos so the per-attempt rotation
// inside a combo call works, but the listing reflects the user's intent:
// "I granted the combo, so the user sees the combo."
export function filterModelsForRule(models, rule, _allCombos) {
  if (!Array.isArray(models)) return [];
  if (!rule || !ruleGrantsAnything(rule)) return [];

  const providers = rule.providers || [];
  const ruleModels = rule.models || [];
  const ruleCombos = rule.combos || [];
  const allProviders = providers.includes(WILDCARD);
  const allModels = ruleModels.includes(WILDCARD);
  const allCombosGranted = ruleCombos.includes(WILDCARD);

  return models.filter((entry) => {
    if (!entry || !entry.id) return false;
    if (entry.owned_by === "combo") {
      return allCombosGranted || ruleCombos.includes(entry.id);
    }
    if (allModels || ruleModels.includes(entry.id)) return true;
    if (allProviders) return true;
    const providerId = resolveProviderId(entry.owned_by);
    if (providers.includes(providerId) || providers.includes(entry.owned_by)) return true;
    return false;
  });
}
