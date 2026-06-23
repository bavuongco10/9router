"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import Card from "@/shared/components/Card";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};
const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;
const fmtNum = (n) => String(n || 0);

const METRICS = [
  { value: "cost", label: "Cost" },
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "Requests" },
];

// Distinct palette for model segments — cycles if there are more models than colors.
const COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#84cc16",
  "#3b82f6", "#a855f7", "#22c55e", "#eab308", "#f43f5e",
];

function metricValue(entry, metric) {
  if (metric === "cost") return entry.cost || 0;
  if (metric === "tokens") return (entry.promptTokens || 0) + (entry.completionTokens || 0);
  return entry.requests || 0;
}

function buildStacked(byApiKey, metric) {
  if (!byApiKey) return { rows: [], models: [] };
  // keyName -> { model -> value }
  const perKey = {};
  // model -> total across keys (for ordering)
  const modelTotals = {};
  for (const entry of Object.values(byApiKey)) {
    const keyName = entry.keyName || "Unknown";
    const model = entry.rawModel || "unknown";
    const v = metricValue(entry, metric);
    if (!v) continue;
    perKey[keyName] ||= {};
    perKey[keyName][model] = (perKey[keyName][model] || 0) + v;
    modelTotals[model] = (modelTotals[model] || 0) + v;
  }
  const models = Object.keys(modelTotals).sort((a, b) => modelTotals[b] - modelTotals[a]);
  const rows = Object.entries(perKey).map(([keyName, perModel]) => {
    const row = { keyName, _total: 0 };
    for (const m of models) {
      row[m] = perModel[m] || 0;
      row._total += row[m];
    }
    return row;
  });
  rows.sort((a, b) => b._total - a._total);
  return { rows, models };
}

export default function ApiKeyComparisonChart({ byApiKey }) {
  const [metric, setMetric] = useState("cost");

  const { rows, models } = useMemo(() => buildStacked(byApiKey, metric), [byApiKey, metric]);

  const hasData = rows.length > 0 && rows.some((r) => r._total > 0);
  const formatter = metric === "cost" ? fmtCost : metric === "tokens" ? fmtTokens : fmtNum;
  const metricLabel = METRICS.find((m) => m.value === metric).label;
  const chartHeight = Math.max(180, rows.length * 36 + 40);
  const colorFor = (i) => COLORS[i % COLORS.length];

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-text-muted text-xs uppercase font-semibold">Usage by API key</span>
        <div className="grid grid-cols-3 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:flex">
          {METRICS.map((m) => (
            <button
              key={m.value}
              onClick={() => setMetric(m.value)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                metric === m.value
                  ? "bg-primary text-white shadow-sm"
                  : "text-text-muted hover:text-text hover:bg-bg-hover"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {!hasData ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">
          No API key usage for this period
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={formatter}
              />
              <YAxis
                type="category"
                dataKey="keyName"
                tick={{ fontSize: 11, fill: "currentColor", fillOpacity: 0.7 }}
                tickLine={false}
                axisLine={false}
                width={140}
              />
              <Tooltip
                cursor={{ fill: "currentColor", fillOpacity: 0.05 }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const segs = payload
                    .map((p) => ({ name: p.dataKey, value: p.value || 0, color: p.color }))
                    .filter((s) => s.value > 0)
                    .sort((a, b) => b.value - a.value);
                  const total = segs.reduce((s, x) => s + x.value, 0);
                  return (
                    <div
                      className="rounded-md border border-border bg-bg px-3 py-2 text-xs shadow-md"
                      style={{ color: "var(--color-text-main)" }}
                    >
                      <div className="mb-1 font-medium truncate max-w-[260px]" title={label}>
                        {label}
                      </div>
                      <div className="mb-1.5 flex items-center gap-2 border-b border-border pb-1">
                        <span className="text-text-muted">{metricLabel} total</span>
                        <span className="ml-auto font-mono tabular-nums">{formatter(total)}</span>
                      </div>
                      <ul className="flex flex-col gap-0.5">
                        {segs.map((s) => (
                          <li key={s.name} className="flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className="inline-block h-2 w-2 rounded-sm"
                              style={{ backgroundColor: s.color }}
                            />
                            <span className="truncate max-w-[200px]" title={s.name}>{s.name}</span>
                            <span className="ml-auto font-mono tabular-nums">{formatter(s.value)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                }}
              />
              {models.map((m, i) => (
                <Bar
                  key={m}
                  dataKey={m}
                  stackId="apiKey"
                  fill={colorFor(i)}
                  radius={i === models.length - 1 ? [0, 4, 4, 0] : 0}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-text-muted">
            {models.map((m, i) => (
              <li key={m} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ backgroundColor: colorFor(i) }}
                />
                <span className="truncate max-w-[200px]" title={m}>{m}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

ApiKeyComparisonChart.propTypes = {
  byApiKey: PropTypes.object,
};
