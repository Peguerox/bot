"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const INITIAL = 2000;

export default function PnLChart({ trades }: { trades: any[] }) {
  if (trades.length === 0) return (
    <div className="h-48 flex items-center justify-center text-gray-600 text-sm">
      No trades yet — bot is watching for signals
    </div>
  );

  let balance = INITIAL;
  const data = [...trades].reverse().map(t => {
    balance += t.pnl ?? 0;
    return {
      time:    new Date(t.exit_time).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      balance: parseFloat(balance.toFixed(2)),
      pnl:     parseFloat((t.pnl ?? 0).toFixed(4)),
    };
  });

  const min = Math.min(...data.map(d => d.balance));
  const max = Math.max(...data.map(d => d.balance));

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <XAxis
          dataKey="time"
          tick={{ fill: "#6b7280", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          domain={[min * 0.999, max * 1.001]}
          tick={{ fill: "#6b7280", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => `$${v.toLocaleString()}`}
          width={80}
        />
        <Tooltip
          contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 8 }}
          labelStyle={{ color: "#9ca3af" }}
          formatter={(v: any) => [`$${v.toLocaleString()}`, "Balance"]}
        />
        <ReferenceLine y={INITIAL} stroke="#374151" strokeDasharray="4 4" />
        <Line
          type="monotone"
          dataKey="balance"
          stroke="#34d399"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: "#34d399" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
