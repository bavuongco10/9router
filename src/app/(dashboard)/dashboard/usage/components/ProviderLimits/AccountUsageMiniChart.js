"use client";

import PropTypes from "prop-types";
import {
  BarChart,
  Bar,
  XAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

// Does this 7-day series have any usage worth charting?
export function hasUsage(data) {
  return Array.isArray(data) && data.some((d) => (d?.tokens || 0) > 0);
}

// Compact weekly (7-day) token usage for a single account, sized to sit
// inside an account tile: full width, fixed short height, no Y axis.
export default function AccountUsageMiniChart({ data }) {
  if (!hasUsage(data)) {
    return (
      <p className="mt-2 border-t border-black/5 pt-2 text-[10px] text-text-muted dark:border-white/5">
        No usage in the last 7 days
      </p>
    );
  }

  return (
    <div className="mt-2 min-w-0 border-t border-black/5 pt-2 dark:border-white/5">
      <p className="mb-1 text-[10px] font-medium text-text-muted">
        Last 7 days · tokens
      </p>
      <ResponsiveContainer width="100%" height={56}>
        <BarChart
          data={data}
          margin={{ top: 2, right: 0, left: 0, bottom: 0 }}
          barCategoryGap="20%"
        >
          <XAxis
            dataKey="label"
            tick={{ fontSize: 9, fill: "currentColor", fillOpacity: 0.5 }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <Tooltip
            cursor={{ fill: "currentColor", fillOpacity: 0.06 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              return (
                <div
                  className="rounded-md border border-border bg-bg px-2 py-1 text-[11px] shadow-md"
                  style={{ color: "var(--color-text-main)" }}
                >
                  <div className="font-medium">{label}</div>
                  <div className="font-mono tabular-nums">
                    {fmtTokens(payload[0].value)} tokens
                  </div>
                </div>
              );
            }}
          />
          <Bar
            dataKey="tokens"
            fill="#6366f1"
            radius={[2, 2, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

AccountUsageMiniChart.propTypes = {
  data: PropTypes.arrayOf(PropTypes.object),
};
