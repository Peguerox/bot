"use client";

const INITIAL = 2000; // $1,000 BNB + $1,000 ATOM

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function StatsCards({ trades, open, loading }: {
  trades: any[]; open: any[]; loading: boolean;
}) {
  if (loading) return <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
    {[...Array(4)].map((_, i) => (
      <div key={i} className="bg-gray-900 rounded-xl p-5 animate-pulse h-24" />
    ))}
  </div>;

  const totalPnL    = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const balance     = INITIAL + totalPnL;
  const wins        = trades.filter(t => t.pnl > 0);
  const losses      = trades.filter(t => t.pnl <= 0);
  const winRate     = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : "—";
  const grossWin    = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf          = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "∞";

  // Max drawdown
  let peak = INITIAL, maxDD = 0, runBal = INITIAL;
  [...trades].reverse().forEach(t => {
    runBal += t.pnl ?? 0;
    if (runBal > peak) peak = runBal;
    const dd = (runBal - peak) / peak * 100;
    if (dd < maxDD) maxDD = dd;
  });

  const cards = [
    {
      label: "Balance",
      value: `$${fmt(balance)}`,
      sub: `${totalPnL >= 0 ? "+" : ""}$${fmt(totalPnL)} PnL`,
      color: totalPnL >= 0 ? "text-green-400" : "text-red-400",
    },
    {
      label: "Win Rate",
      value: `${winRate}%`,
      sub: `${wins.length}W / ${losses.length}L of ${trades.length} trades`,
      color: "text-blue-400",
    },
    {
      label: "Profit Factor",
      value: pf,
      sub: open.length > 0 ? `${open.length} position${open.length > 1 ? "s" : ""} open` : "No open positions",
      color: "text-purple-400",
    },
    {
      label: "Max Drawdown",
      value: `${maxDD.toFixed(1)}%`,
      sub: `Started $${fmt(INITIAL)}`,
      color: maxDD < -10 ? "text-red-400" : "text-yellow-400",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(c => (
        <div key={c.label} className="bg-gray-900 rounded-xl p-5">
          <p className="text-gray-500 text-xs uppercase tracking-wide">{c.label}</p>
          <p className={`text-2xl font-bold mt-1 ${c.color}`}>{c.value}</p>
          <p className="text-gray-500 text-xs mt-1">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}
