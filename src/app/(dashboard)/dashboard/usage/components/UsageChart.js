"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import Card from "@/shared/components/Card";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;
const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

export default function UsageChart({ period = "7d" }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState("tokens");
  const [filterBy, setFilterBy] = useState("all");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/usage/chart?period=${period}`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (e) {
      console.error("Failed to fetch chart data:", e);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const hasData = data.some((d) => d.tokens > 0 || d.cost > 0 || d.cachedTokens > 0);

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid w-full grid-cols-4 items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 sm:w-auto sm:self-start">
          <button
            onClick={() => setViewMode("tokens")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Tokens
          </button>
          <button
            onClick={() => setViewMode("cached")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "cached" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Cached
          </button>
          <button
            onClick={() => setViewMode("cacheHit")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "cacheHit" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Cache %
          </button>
          <button
            onClick={() => setViewMode("cost")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "cost" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Cost
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">Filter:</span>
          <select
            value={filterBy}
            onChange={(e) => setFilterBy(e.target.value)}
            className="rounded-lg border border-border bg-surface px-2 py-1 text-xs font-medium text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50"
            style={{ colorScheme: 'auto' }}
          >
            <option value="all">All</option>
            <option value="model">By Model</option>
            <option value="account">By Account</option>
            <option value="apiKey">By API Key</option>
            <option value="endpoint">By Endpoint</option>
          </select>
        </div>
      </div>
      {loading ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">Loading...</div>
      ) : !hasData ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">No data for this period</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradCached" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="tokens"
              tick={{ fontSize: 10, fill: "#6366f1", fillOpacity: 0.85 }}
              tickLine={false}
              axisLine={false}
              yAxisId="tokens"
              tickFormatter={viewMode === "cost" ? fmtCost : viewMode === "cacheHit" ? fmtPct : fmtTokens}
              width={50}
            />
            <Tooltip
              cursor={{ stroke: "currentColor", strokeOpacity: 0.15 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const fmt = (key, value) => {
                  if (key === "tokens" || key === "cachedTokens") return fmtTokens(value);
                  if (key === "cacheHitRatio") return fmtPct(value);
                  if (key === "cost") return fmtCost(value);
                  return value;
                };
                const labelFor = (key) => {
                  if (key === "tokens") return "Tokens";
                  if (key === "cachedTokens") return "Cached Tokens";
                  if (key === "cacheHitRatio") return "Cache Hit %";
                  if (key === "cost") return "Cost";
                  return key;
                };
                return (
                  <div
                    className="rounded-md border border-border bg-bg px-3 py-2 text-xs shadow-md"
                    style={{ color: "var(--color-text-main)" }}
                  >
                    <div className="mb-1 font-medium">{label}</div>
                    {payload.map((p) => (
                      <div key={p.dataKey} className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          className="inline-block h-2 w-2 rounded-sm"
                          style={{ backgroundColor: p.color || p.stroke }}
                        />
                        <span className="text-text-muted">{labelFor(p.dataKey)}</span>
                        <span className="ml-auto font-mono tabular-nums">
                          {fmt(p.dataKey, p.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            {viewMode === "tokens" && (
              <Area
                yAxisId="tokens"
                type="monotone"
                dataKey="tokens"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#gradTokens)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
            {viewMode === "cached" && (
              <>
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="tokens"
                  stroke="#6366f1"
                  strokeWidth={1}
                  fill="url(#gradTokens)"
                  dot={false}
                  activeDot={{ r: 4 }}
                  name="tokens"
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cachedTokens"
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#gradCached)"
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </>
            )}
            {viewMode === "cacheHit" && (
              <Area
                yAxisId="tokens"
                type="monotone"
                dataKey="cacheHitRatio"
                stroke="#10b981"
                strokeWidth={2}
                fill="url(#gradCached)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
            {viewMode === "cost" && (
              <Area
                yAxisId="tokens"
                type="monotone"
                dataKey="cost"
                stroke="#f59e0b"
                strokeWidth={2}
                fill="url(#gradCost)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

UsageChart.propTypes = {
  period: PropTypes.string,
};
