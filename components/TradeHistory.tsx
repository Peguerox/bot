"use client";

export default function TradeHistory({ trades, loading }: {
  trades: any[]; loading: boolean;
}) {
  if (loading) return <div className="animate-pulse space-y-2">
    {[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-gray-800 rounded" />)}
  </div>;

  if (trades.length === 0) return (
    <p className="text-gray-600 text-sm">No completed trades yet</p>
  );

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs uppercase tracking-wide border-b border-gray-800">
            <th className="text-left pb-2">Pair</th>
            <th className="text-left pb-2">Result</th>
            <th className="text-right pb-2">PnL</th>
            <th className="text-right pb-2">Time</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800/50">
          {trades.map(t => {
            const isWin = t.pnl > 0;
            const badge =
              t.result === "TP" ? "bg-green-500/20 text-green-400" :
              t.result === "SL" ? "bg-red-500/20 text-red-400" :
              "bg-gray-500/20 text-gray-400";
            return (
              <tr key={t.id} className="hover:bg-gray-800/30 transition-colors">
                <td className="py-2 font-medium text-white">{t.pair}</td>
                <td className="py-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${badge}`}>
                    {t.result}
                  </span>
                </td>
                <td className={`py-2 text-right font-mono text-xs ${isWin ? "text-green-400" : "text-red-400"}`}>
                  {isWin ? "+" : ""}{t.pnl?.toFixed(4)}
                </td>
                <td className="py-2 text-right text-gray-600 text-xs">
                  {t.exit_time ? new Date(t.exit_time).toLocaleTimeString("en-US", {
                    hour: "2-digit", minute: "2-digit"
                  }) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
