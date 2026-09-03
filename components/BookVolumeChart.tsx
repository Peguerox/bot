"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

export default function BookVolumeChart({ log }: { log: any[] }) {
  if (log.length === 0) return (
    <div className="h-56 flex items-center justify-center text-gray-600 text-sm">
      No data yet — logging every 5s
    </div>
  );

  const data = log.map((r, i) => ({
    i,
    label: new Date(r.logged_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
    price: parseFloat(r.price),
    imbalance: parseFloat(r.imbalance),
    bidVolume: parseFloat(r.bid_volume),
    askVolume: parseFloat(r.ask_volume),
  }));

  const prices = data.map(d => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <XAxis dataKey="i" tick={false} tickLine={false} axisLine={false} />
        <YAxis
          yAxisId="price"
          domain={[min * 0.9995, max * 1.0005]}
          tick={{ fill: "#facc15", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => `$${v.toFixed(2)}`}
          width={70}
        />
        <YAxis
          yAxisId="imbalance"
          orientation="right"
          domain={[-1, 1]}
          tick={{ fill: "#60a5fa", fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={v => v.toFixed(2)}
          width={50}
        />
        <Tooltip
          contentStyle={{ backgroundColor: "#111827", border: "1px solid #374151", borderRadius: 8 }}
          labelStyle={{ color: "#9ca3af" }}
          labelFormatter={(_: any, payload: readonly any[]) => payload?.[0]?.payload?.label ?? ""}
          formatter={(v: any, name: any) => {
            if (name === "price") return [`$${Number(v).toFixed(4)}`, "Price"];
            if (name === "imbalance") return [Number(v).toFixed(4), "Imbalance"];
            return [v, name];
          }}
        />
        <ReferenceLine yAxisId="imbalance" y={0} stroke="#374151" strokeDasharray="4 4" />
        <Line yAxisId="price" type="monotone" dataKey="price" stroke="#facc15" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line yAxisId="imbalance" type="monotone" dataKey="imbalance" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
