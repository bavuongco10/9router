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
  Cell,
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

// Distinct palette for bar colors — cycles if there are more keys than colors.
const COLORS = [
  "#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#84cc16",
];

function aggregateByKeyName(byApiKey) {
  if (!byApiKey) return [];
  const map = {};
  for (const entry of Object.values(byApiKey)) {
    const name = entry.keyName || "Unknown";
    if (!map[name]) {
      map[name] = { keyName: name, cost: 0, tokens: 0, requests: 0 };
    }
    map[name].cost += entry.cost || 0;
    map[name].tokens += (entry.promptTokens || 0) + (entry.completionTokens || 0);
    map[name].requests += entry.requests || 0;
  }
  return Object.values(map);
}

export default function ApiKeyComparisonChart({ byApiKey }) {
  const [metric, setMetric] = useState("cost");

  const data = useMemo(() => {
    const rows = aggregateByKeyName(byApiKey);
    return rows.sort((a, b) => b[metric] - a[metric]);
  }, [byApiKey, metric]);

  const hasData = data.some((d) => d[metric] > 0);

  const formatter = metric === "cost" ? fmtCost : metric === "tokens" ? fmtTokens : fmtNum;
  const metricLabel = METRICS.find((m) => m.value === metric).label;
  const chartHeight = Math.max(180, data.length * 36 + 40);

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
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 0, bottom: 0 }}>
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
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              cursor={{ fill: "currentColor", fillOpacity: 0.05 }}
              formatter={(value) => [formatter(value), metricLabel]}
            />
            <Bar dataKey={metric} radius={[0, 4, 4, 0]}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

ApiKeyComparisonChart.propTypes = {
  byApiKey: PropTypes.object,
};
