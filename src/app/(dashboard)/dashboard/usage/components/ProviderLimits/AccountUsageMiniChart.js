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

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316", "#84cc16"];

// Does this account's 7-day breakdown have any usage worth charting?
export function hasUsage(entry) {
  return (
    entry &&
    Array.isArray(entry.data) &&
    Array.isArray(entry.models) &&
    entry.models.length > 0 &&
    entry.data.some((d) => entry.models.some((m) => (d[m] || 0) > 0))
  );
}

// Compact weekly (7-day) token usage for a single account, each day's bar
// stacked by model. Sized to sit inside an account tile: full width, short
// fixed height, no Y axis; model names live in the hover tooltip to keep the
// tile short (a persistent legend would grow it).
// ponytail: model→color mapping is positional per-tile (index in this
// account's models[]), so the same model may differ in color across tiles.
// Upgrade to a shared model→color map if cross-tile consistency is wanted.
export default function AccountUsageMiniChart({ data }) {
  if (!hasUsage(data)) {
    return (
      <p className="mt-2 border-t border-black/5 pt-2 text-[10px] text-text-muted dark:border-white/5">
        No usage in the last 7 days
      </p>
    );
  }

  const { models, data: series } = data;

  // Pseudo-log stack: recharts can't put a stacked bar on a real log axis
  // (log(0) = -∞), so scale each bar's total to log10(total) and split that
  // height across models by their real share. Keeps a 2k day visible next to
  // a 2M one; __real carries the true token counts for the tooltip.
  // ponytail: not a true log axis (tick values are meaningless, so no Y axis).
  // Upgrade to a real log axis only if we drop stacking.
  const scaled = series.map((d) => {
    const real = {};
    let total = 0;
    for (const m of models) { const v = d[m] || 0; real[m] = v; total += v; }
    const factor = total > 0 ? Math.log10(total + 1) / total : 0;
    const out = { label: d.label, __real: real };
    for (const m of models) out[m] = (d[m] || 0) * factor;
    return out;
  });

  return (
    <div className="mt-2 min-w-0 border-t border-black/5 pt-2 dark:border-white/5">
      <p className="mb-1 text-[10px] font-medium text-text-muted">
        Last 7 days · tokens by model (log)
      </p>
      <ResponsiveContainer width="100%" height={64}>
        <BarChart
          data={scaled}
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
              const real = payload[0]?.payload?.__real || {};
              const rows = payload
                .map((p) => ({ key: p.dataKey, color: p.color || p.fill, value: real[p.dataKey] || 0 }))
                .filter((r) => r.value > 0)
                .sort((a, b) => b.value - a.value);
              if (!rows.length) return null;
              const total = rows.reduce((s, r) => s + r.value, 0);
              return (
                <div
                  className="max-w-[220px] rounded-md border border-border bg-bg px-2 py-1 text-[11px] shadow-md"
                  style={{ color: "var(--color-text-main)" }}
                >
                  <div className="mb-0.5 font-medium">{label}</div>
                  {rows.map((r) => (
                    <div key={r.key} className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2 w-2 shrink-0 rounded-sm"
                        style={{ backgroundColor: r.color }}
                      />
                      <span className="truncate">{r.key}</span>
                      <span className="ml-auto font-mono tabular-nums">
                        {fmtTokens(r.value)}
                      </span>
                    </div>
                  ))}
                  <div className="mt-0.5 flex border-t border-black/10 pt-0.5 dark:border-white/10">
                    <span className="text-text-muted">Total</span>
                    <span className="ml-auto font-mono tabular-nums">
                      {fmtTokens(total)}
                    </span>
                  </div>
                </div>
              );
            }}
          />
          {models.map((m, i) => (
            <Bar
              key={m}
              dataKey={m}
              stackId="a"
              fill={COLORS[i % COLORS.length]}
              radius={i === models.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

AccountUsageMiniChart.propTypes = {
  data: PropTypes.shape({
    models: PropTypes.arrayOf(PropTypes.string),
    data: PropTypes.arrayOf(PropTypes.object),
  }),
};
