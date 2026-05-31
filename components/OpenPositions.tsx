"use client";

import { useEffect, useState } from "react";

export default function OpenPositions({ positions, loading }: {
  positions: any[]; loading: boolean;
}) {
  const [prices, setPrices] = useState<Record<string, number>>({});

  useEffect(() => {
    async function fetchPrices() {
      const syms = [...new Set(positions.map(p =>
        p.pair === "BNB" ? "BNBUSDT" : "ATOMUSDT"
      ))];
      const updated: Record<string, number> = {};
      await Promise.all(syms.map(async sym => {
        const r = await fetch(`https://api.binance.us/api/v3/ticker/price?symbol=${sym}`);
        const d = await r.json();
        const key = sym.replace("USDT", "");
        updated[key] = parseFloat(d.price);
      }));
      setPrices(updated);
    }
    if (positions.length > 0) {
      fetchPrices();
      const id = setInterval(fetchPrices, 10000); // refresh every 10s
      return () => clearInterval(id);
    }
  }, [positions]);

  if (loading) return <div className="animate-pulse space-y-2">
    {[1,2].map(i => <div key={i} className="h-16 bg-gray-800 rounded-lg" />)}
  </div>;

  if (positions.length === 0) return (
    <p className="text-gray-600 text-sm">No open positions — watching for signals</p>
  );

  return (
    <div className="space-y-3">
      {positions.map(pos => {
        const price   = prices[pos.pair] ?? pos.entry_price;
        const livePnL = (price - pos.entry_price) * pos.quantity;
        const pct     = ((price - pos.entry_price) / pos.entry_price * 100).toFixed(2);
        const isUp    = livePnL >= 0;

        return (
          <div key={pos.id} className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-white">{pos.pair}</span>
                <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">
                  LONG
                </span>
                <span className="text-xs text-gray-500">Hold {pos.hold_count}/3</span>
              </div>
              <div className="text-gray-500 text-xs mt-1">
                Entry ${pos.entry_price.toFixed(4)} · SL ${pos.sl.toFixed(4)} · TP ${pos.tp.toFixed(4)}
              </div>
            </div>
            <div className="text-right">
              <p className={`font-semibold ${isUp ? "text-green-400" : "text-red-400"}`}>
                {isUp ? "+" : ""}{livePnL.toFixed(2)} USDT
              </p>
              <p className={`text-xs ${isUp ? "text-green-500" : "text-red-500"}`}>
                {isUp ? "+" : ""}{pct}%
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
