"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Button, Input, Select } from "@/shared/components";

function describeConnection(conn) {
  if (!conn) return "";
  return conn.displayName || conn.name || conn.email || conn.id?.slice(0, 8) || "Unnamed";
}

export default function TestConnectionModelModal({
  isOpen,
  onClose,
  connections,
  initialConnectionId,
  providerStorageAlias,
  fallbackModels = [],
}) {
  const [selectedConnectionId, setSelectedConnectionId] = useState(initialConnectionId || "");
  const [model, setModel] = useState("");
  const [models, setModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null);
  const lastFetchKey = useRef(null);

  // Reset state when opened / when seeded connection changes.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedConnectionId(initialConnectionId || "");
    setModel("");
    setResult(null);
    setModelsError(null);
  }, [isOpen, initialConnectionId]);

  // Fetch the model list for the selected connection.
  useEffect(() => {
    if (!isOpen || !selectedConnectionId) {
      setModels([]);
      return;
    }
    const key = selectedConnectionId;
    lastFetchKey.current = key;
    setLoadingModels(true);
    setModelsError(null);
    fetch(`/api/providers/${selectedConnectionId}/models`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (lastFetchKey.current !== key) return;
        if (!res.ok) {
          setModels([]);
          setModelsError(data?.error || `Failed to load models (${res.status})`);
          return;
        }
        const list = Array.isArray(data?.models) ? data.models : [];
        setModels(list);
      })
      .catch((err) => {
        if (lastFetchKey.current !== key) return;
        setModels([]);
        setModelsError(err?.message || "Failed to load models");
      })
      .finally(() => {
        if (lastFetchKey.current === key) setLoadingModels(false);
      });
  }, [isOpen, selectedConnectionId]);

  const connectionOptions = useMemo(
    () =>
      (connections || []).map((conn) => ({
        value: conn.id,
        label: describeConnection(conn) + (conn.isActive === false ? " (disabled)" : ""),
      })),
    [connections]
  );

  const liveModelIds = useMemo(() => {
    const ids = new Set();
    for (const m of models) {
      const id = m?.id || m?.name || m?.model;
      if (id) ids.add(String(id));
    }
    return ids;
  }, [models]);

  const fallbackModelIds = useMemo(() => {
    const ids = new Set();
    for (const m of fallbackModels || []) {
      const id = m?.id || m?.name || m?.model;
      if (id) ids.add(String(id));
    }
    return ids;
  }, [fallbackModels]);

  // Union of live + static so the user can pick even when the live fetch 401s
  // on an expired OAuth token.
  const modelIds = useMemo(() => {
    return [...new Set([...liveModelIds, ...fallbackModelIds])];
  }, [liveModelIds, fallbackModelIds]);

  const handleTest = async () => {
    if (!selectedConnectionId || !model.trim() || testing) return;
    setTesting(true);
    setResult(null);
    try {
      const modelId = model.trim();
      // Router resolves "<providerStorageAlias>/<modelId>" the same way the
      // Available Models test button does. The connectionId pins the call to
      // a specific connection on the server side (strict — no fallback).
      const fullModel = modelId.includes("/") ? modelId : `${providerStorageAlias}/${modelId}`;
      const res = await fetch("/api/models/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: fullModel,
          connectionId: selectedConnectionId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      setResult({
        ok: !!data.ok,
        latencyMs: data.latencyMs ?? null,
        status: data.status ?? res.status,
        error: data.error || (data.ok ? null : `HTTP ${res.status}`),
      });
    } catch (err) {
      setResult({ ok: false, latencyMs: null, status: null, error: err?.message || "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const datalistId = "test-connection-model-options";
  const canTest = !!selectedConnectionId && !!model.trim() && !testing;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Test connection"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={testing}>
            Close
          </Button>
          <Button onClick={handleTest} disabled={!canTest}>
            {testing ? "Testing…" : "Test"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Connection"
          value={selectedConnectionId}
          onChange={(e) => setSelectedConnectionId(e.target.value)}
          options={connectionOptions}
          placeholder="Select a connection"
          hint="The test call uses this connection's credentials. No fallback to other connections."
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-main">Model</label>
          <input
            list={datalistId}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={loadingModels ? "Loading models…" : "Pick a model or type one"}
            className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 border border-transparent rounded-[10px] focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 transition-all duration-150"
          />
          <datalist id={datalistId}>
            {modelIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <p className="text-xs text-text-muted">
            {(() => {
              const live = liveModelIds.size;
              const fallback = fallbackModelIds.size;
              if (loadingModels && live === 0) return " ";
              if (modelsError && live === 0 && fallback > 0) {
                return `Live model list unavailable (${modelsError}). Showing ${fallback} model${fallback === 1 ? "" : "s"} from the static catalog. Free-text also accepted.`;
              }
              if (modelsError && live === 0) {
                return `Could not load model list (${modelsError}). You can still type a model id.`;
              }
              if (live > 0 && fallback > 0) {
                return `${live} live + ${modelIds.length - live} catalog model${modelIds.length - live === 1 ? "" : "s"}. Free-text also accepted.`;
              }
              if (live > 0) {
                return `${live} model${live === 1 ? "" : "s"} fetched from this connection. Free-text also accepted.`;
              }
              if (fallback > 0) {
                return `${fallback} model${fallback === 1 ? "" : "s"} from the static catalog. Free-text also accepted.`;
              }
              return "No model list available for this connection — type a model id.";
            })()}
          </p>
        </div>

        {result && (
          <div
            className={
              "rounded-[10px] border p-3 text-sm " +
              (result.ok
                ? "border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-300"
                : "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300")
            }
          >
            <div className="flex items-center gap-2 font-medium">
              <span className="material-symbols-outlined text-base">
                {result.ok ? "check_circle" : "cancel"}
              </span>
              {result.ok ? "OK" : "Failed"}
              {typeof result.latencyMs === "number" && (
                <span className="text-xs opacity-80">· {result.latencyMs} ms</span>
              )}
              {result.status != null && (
                <span className="text-xs opacity-80">· status {result.status}</span>
              )}
            </div>
            {result.error && <div className="mt-1 text-xs break-all">{result.error}</div>}
          </div>
        )}
      </div>
    </Modal>
  );
}
