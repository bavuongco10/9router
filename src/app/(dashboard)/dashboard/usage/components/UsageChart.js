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

export default function UsageChart({ period = "7d" }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

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

  const hasData = data.some((d) => d.tokens > 0 || d.cost > 0);

  return (
    <Card className="flex min-w-0 flex-col gap-3 p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-muted text-xs uppercase font-semibold">Cost over time</span>
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
              tickFormatter={fmtTokens}
              width={50}
            />
            <YAxis
              yAxisId="cost"
              orientation="right"
              tick={{ fontSize: 10, fill: "#f59e0b", fillOpacity: 0.85 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={fmtCost}
              width={56}
            />
            <Tooltip
              cursor={{ stroke: "currentColor", strokeOpacity: 0.15 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
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
                        <span className="text-text-muted">{p.name}</span>
                        <span className="ml-auto font-mono tabular-nums">
                          {p.dataKey === "tokens" ? fmtTokens(p.value) : fmtCost(p.value)}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            <Legend wrapperStyle={{ fontSize: "12px" }} />
            <Area
              yAxisId="tokens"
              type="monotone"
              dataKey="tokens"
              name="Tokens"
              stroke="#6366f1"
              strokeWidth={2}
              fill="url(#gradTokens)"
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="cost"
              name="Cost"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

UsageChart.propTypes = {
  period: PropTypes.string,
};
