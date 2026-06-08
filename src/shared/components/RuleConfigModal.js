"use client";

import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";
import { cn } from "@/shared/utils/cn";
import { useNotificationStore } from "@/store/notificationStore";

const WILDCARD = "*";
const DIMS = ["providers", "connections", "models", "combos"];

// One section in the modal (Providers / Connections / Models / Combos).
// Every section supports: multi-select, "All" toggle (stores ["*"]), Clear all,
// per-item delete via removable chips. Children render the row list.
function Section({ title, dim, selected, onChange, count, allLabel, children }) {
  const isAll = selected.length === 1 && selected[0] === WILDCARD;
  const isEmpty = selected.length === 0;
  const setAll = () => onChange(isAll ? [] : [WILDCARD]);
  const clearAll = () => onChange([]);
  return (
    <div className="border border-black/5 dark:border-white/5 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-black/[0.02] dark:bg-white/[0.02]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-sm text-text-main truncate">{title}</span>
          <span className="text-xs text-text-muted">
            {isAll ? `All ${dim}` : `${selected.length} of ${count}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={setAll}
            className={cn(
              "h-7 px-2 rounded-md border text-xs cursor-pointer",
              isAll
                ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400"
                : "border-black/10 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/5"
            )}
          >
            {isAll ? `${allLabel}: ON` : allLabel}
          </button>
          <button
            type="button"
            onClick={clearAll}
            disabled={isEmpty}
            className="h-7 px-2 rounded-md border border-black/10 dark:border-white/10 text-xs hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Clear all
          </button>
        </div>
      </div>
      <div className={cn("p-3", isAll && "opacity-60")}>{children({ isAll })}</div>
    </div>
  );
}

// Removable chip for a single selected id (or the "*" wildcard).
function Chip({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-black/[0.06] dark:bg-white/[0.08] text-xs">
      <span className="truncate max-w-[180px]">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="opacity-60 hover:opacity-100 cursor-pointer"
      >
        ×
      </button>
    </span>
  );
}

function CheckRow({ checked, disabled, onToggle, label, sub }) {
  return (
    <label className={cn(
      "flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer",
      disabled ? "cursor-not-allowed" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
    )}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} />
      <span className="truncate">{label}</span>
      {sub && <span className="text-xs text-text-muted truncate">— {sub}</span>}
    </label>
  );
}

export default function RuleConfigModal({ apiKey, options, onClose, onSaved }) {
  const notify = useNotificationStore();
  const seed = apiKey?.rule || { providers: [], connections: [], models: [], combos: [] };
  const [providers, setProviders] = useState(seed.providers || []);
  const [connections, setConnections] = useState(seed.connections || []);
  const [models, setModels] = useState(seed.models || []);
  const [combos, setCombos] = useState(seed.combos || []);
  const [modelQuery, setModelQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Re-seed if the modal is reused for another key (defensive).
  useEffect(() => {
    setProviders(seed.providers || []);
    setConnections(seed.connections || []);
    setModels(seed.models || []);
    setCombos(seed.combos || []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey?.id]);

  const opts = options || {};
  const optProviders = opts.providers || [];
  const connsByProvider = opts.connectionsByProvider || {};
  const optModels = opts.models || [];
  const optCombos = opts.combos || [];

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return optModels;
    return optModels.filter((m) => m.id.toLowerCase().includes(q));
  }, [modelQuery, optModels]);

  const counts = {
    providers: optProviders.length,
    connections: Object.values(connsByProvider).reduce((n, arr) => n + arr.length, 0),
    models: optModels.length,
    combos: optCombos.length,
  };

  const toggleIn = (arr, setArr) => (id) => {
    if (arr.length === 1 && arr[0] === WILDCARD) return; // "All" mode locks individual rows
    setArr(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);
  };
  const removeFrom = (arr, setArr) => (id) => setArr(arr.filter((x) => x !== id));

  const hadRule = !!apiKey?.rule && (
    (apiKey.rule.providers?.length || 0) +
    (apiKey.rule.connections?.length || 0) +
    (apiKey.rule.models?.length || 0) +
    (apiKey.rule.combos?.length || 0)
  ) > 0;

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(`/api/rules/${apiKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providers, connections, models, combos }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        notify.error?.(e.error || "Failed to save rule");
        return;
      }
      notify.success?.("Rule saved");
      onSaved?.();
      onClose?.();
    } catch (err) {
      notify.error?.(err?.message || "Failed to save rule");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch(`/api/rules/${apiKey.id}`, { method: "DELETE" });
      if (!res.ok) {
        notify.error?.("Failed to remove rule");
        return;
      }
      notify.success?.("Rule removed (default-deny)");
      onSaved?.();
      onClose?.();
    } catch (err) {
      notify.error?.(err?.message || "Failed to remove rule");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Modal isOpen={true} onClose={onClose} title={`Rule — ${apiKey?.name || ""}`} size="lg">
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">
          Default-deny: this key can access only what its rule grants. Pick All for any
          dimension to auto-include future items.
        </p>

        <Section
          title="Providers"
          dim="providers"
          selected={providers}
          onChange={setProviders}
          count={counts.providers}
          allLabel="All providers"
        >
          {({ isAll }) => (
            <RuleSectionBody
              isAll={isAll}
              selected={providers}
              onRemove={removeFrom(providers, setProviders)}
              all={optProviders}
              renderRow={(p) => (
                <CheckRow
                  key={p.id}
                  checked={providers.includes(p.id)}
                  disabled={isAll}
                  onToggle={() => toggleIn(providers, setProviders)(p.id)}
                  label={p.name}
                  sub={p.id}
                />
              )}
            />
          )}
        </Section>

        <Section
          title="Connections"
          dim="connections"
          selected={connections}
          onChange={setConnections}
          count={counts.connections}
          allLabel="All connections"
        >
          {({ isAll }) => (
            <ChipsAndList
              isAll={isAll}
              selected={connections}
              onRemove={removeFrom(connections, setConnections)}
              labelFor={(id) => {
                for (const arr of Object.values(connsByProvider)) {
                  const c = arr.find((x) => x.id === id);
                  if (c) return c.name || id;
                }
                return id;
              }}
            >
              {Object.entries(connsByProvider).map(([providerId, conns]) => (
                <div key={providerId} className="mb-2 last:mb-0">
                  <div className="text-[11px] uppercase tracking-wide text-text-muted px-1 pb-1">
                    {opts.providerNameMap?.[providerId] || providerId}
                  </div>
                  {conns.map((c) => (
                    <CheckRow
                      key={c.id}
                      checked={connections.includes(c.id)}
                      disabled={isAll}
                      onToggle={() => toggleIn(connections, setConnections)(c.id)}
                      label={c.name || c.id}
                      sub={c.id}
                    />
                  ))}
                </div>
              ))}
            </ChipsAndList>
          )}
        </Section>

        <Section
          title="Models"
          dim="models"
          selected={models}
          onChange={setModels}
          count={counts.models}
          allLabel="All models"
        >
          {({ isAll }) => (
            <div className="flex flex-col gap-2">
              <SelectedChips selected={models} onRemove={removeFrom(models, setModels)} />
              <Input
                placeholder="Search models…"
                value={modelQuery}
                onChange={(e) => setModelQuery(e.target.value)}
              />
              <div className="max-h-56 overflow-auto rounded border border-black/5 dark:border-white/5">
                {filteredModels.map((m) => (
                  <CheckRow
                    key={m.id}
                    checked={models.includes(m.id)}
                    disabled={isAll}
                    onToggle={() => toggleIn(models, setModels)(m.id)}
                    label={m.id}
                  />
                ))}
                {filteredModels.length === 0 && (
                  <div className="text-xs text-text-muted p-2">No models match.</div>
                )}
              </div>
            </div>
          )}
        </Section>

        <Section
          title="Combos"
          dim="combos"
          selected={combos}
          onChange={setCombos}
          count={counts.combos}
          allLabel="All combos"
        >
          {({ isAll }) => (
            <RuleSectionBody
              isAll={isAll}
              selected={combos}
              onRemove={removeFrom(combos, setCombos)}
              all={optCombos}
              renderRow={(c) => (
                <CheckRow
                  key={c.name}
                  checked={combos.includes(c.name)}
                  disabled={isAll}
                  onToggle={() => toggleIn(combos, setCombos)(c.name)}
                  label={c.name}
                />
              )}
            />
          )}
        </Section>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-black/5 dark:border-white/5">
          {hadRule ? (
            <Button variant="ghost" onClick={handleRemove} disabled={removing || saving}>
              {removing ? "Removing…" : "Remove rule"}
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving || removing}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || removing}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function SelectedChips({ selected, onRemove }) {
  if (!selected.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {selected.map((id) => (
        <Chip key={id} label={id === WILDCARD ? "All" : id} onRemove={() => onRemove(id)} />
      ))}
    </div>
  );
}

function RuleSectionBody({ isAll, selected, onRemove, all, renderRow }) {
  return (
    <div className="flex flex-col gap-2">
      <SelectedChips selected={selected} onRemove={onRemove} />
      <div className="max-h-56 overflow-auto rounded border border-black/5 dark:border-white/5">
        {all.length ? all.map(renderRow) : (
          <div className="text-xs text-text-muted p-2">Nothing to pick yet.</div>
        )}
      </div>
    </div>
  );
}

function ChipsAndList({ isAll, selected, onRemove, labelFor, children }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {selected.map((id) => (
          <Chip
            key={id}
            label={id === WILDCARD ? "All" : labelFor(id)}
            onRemove={() => onRemove(id)}
          />
        ))}
      </div>
      <div className="max-h-56 overflow-auto rounded border border-black/5 dark:border-white/5 px-1 py-1">
        {children}
      </div>
    </div>
  );
}
