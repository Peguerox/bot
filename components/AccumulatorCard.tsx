"use client";

export default function AccumulatorCard({ state, switches, loading }: {
  state: any; switches: any[]; loading: boolean;
}) {
  if (loading) return (
    <div className="bg-gray-900 rounded-xl p-5 animate-pulse">
      <div className="h-4 bg-gray-800 rounded w-40 mb-4" />
      <div className="h-16 bg-gray-800 rounded" />
    </div>
  );

  if (!state) return (
    <div className="bg-gray-900 rounded-xl p-5">
      <h2 className="text-gray-300 font-semibold mb-2">SOL/BTC Accumulator</h2>
      <p className="text-gray-600 text-sm">Waiting for first run...</p>
    </div>
  );

  const startBtc    = switches.length > 0
    ? switches[switches.length - 1]?.btc_value_before ?? state.btc_value
    : state.btc_value;
  const gainBtc     = state.btc_value - startBtc;
  const gainPct     = startBtc > 0 ? (gainBtc / startBtc) * 100 : 0;
  const isSOL       = state.holding === "SOL";

  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-gray-300 font-semibold">SOL/BTC Accumulator</h2>
        <span className="text-gray-500 text-xs">5m · BB(10) · Paper</span>
      </div>

      {/* Current holding */}
      <div className="flex items-center gap-3">
        <div className={`px-3 py-1 rounded-full text-sm font-bold ${
          isSOL ? "bg-purple-500/20 text-purple-400" : "bg-orange-500/20 text-orange-400"
        }`}>
          Holding {state.holding}
        </div>
        <span className="text-gray-500 text-xs">{state.switches} switches total</span>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-800/50 rounded-lg p-3">
          <p className="text-gray-500 text-xs mb-1">BTC Value</p>
          <p className="text-white font-mono text-sm">{Number(state.btc_value).toFixed(6)}</p>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <p className="text-gray-500 text-xs mb-1">BTC Gain</p>
          <p className={`font-mono text-sm ${gainBtc >= 0 ? "text-green-400" : "text-red-400"}`}>
            {gainBtc >= 0 ? "+" : ""}{gainBtc.toFixed(6)}
          </p>
        </div>
        <div className="bg-gray-800/50 rounded-lg p-3">
          <p className="text-gray-500 text-xs mb-1">Gain %</p>
          <p className={`font-mono text-sm ${gainPct >= 0 ? "text-green-400" : "text-red-400"}`}>
            {gainPct >= 0 ? "+" : ""}{gainPct.toFixed(2)}%
          </p>
        </div>
      </div>

      {/* Recent switches */}
      {switches.length > 0 && (
        <div>
          <p className="text-gray-500 text-xs mb-2">Recent Switches</p>
          <div className="space-y-1">
            {switches.slice(0, 5).map((s: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-gray-400">
                  {s.from_asset} → {s.to_asset}
                </span>
                <span className="text-gray-600 font-mono">
                  {Number(s.sol_btc_price).toFixed(6)} SOLBTC
                </span>
                <span className="text-gray-600">
                  {new Date(s.switched_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
