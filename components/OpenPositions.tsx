"use client";

import { useEffect, useState } from "react";

function pairToSym(pair: string) {
  if (pair === "BTC")  return "BTCUSDT";
  if (pair === "BNB")  return "BNBUSDT";
  if (pair === "XLM")  return "XLMUSDT";
  if (pair === "SOL")  return "SOLUSDT";
  if (pair === "XRP")  return "XRPUSDT";
  return "ATOMUSDT";
}

function fmtPrice(price: number, pair: string) {
  if (pair === "BTC") return price.toFixed(2);
  if (pair === "BNB" || pair === "SOL") return price.toFixed(2);
  if (pair === "XRP") return price.toFixed(4);
  return price.toFixed(5);
}

export default function OpenPositions({ positions, loading }: {
  positions: any[]; loading: boolean;
}) {
  const [prices, setPrices] = useState<Record<string, number>>({});

  useEffect(() => {
    async function fetchPrices() {
      const syms = [...new Set(positions.map(p => pairToSym(p.pair)))];
      const updated: Record<string, number> = {};
      await Promise.all(syms.map(async sym => {
        const r = await fetch(`https://api.binance.us/api/v3/ticker/price?symbol=${sym}`);
        const d = await r.json();
        updated[sym.replace("USDT", "")] = parseFloat(d.price);
      }));
      setPrices(updated);
    }
    if (positions.length > 0) {
      fetchPrices();
      const id = setInterval(fetchPrices, 10000);
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
        const isPending = pos.status === "pending_entry";
        const price     = prices[pos.pair] ?? pos.entry_price ?? 0;
        const exitPrice = pos.status === "chasing" ? pos.chase_price : price;
        const livePnL   = pos.entry_price != null ? (exitPrice - pos.entry_price) * (pos.quantity ?? 0) : null;
        const pct       = pos.entry_price != null ? ((exitPrice - pos.entry_price) / pos.entry_price * 100).toFixed(2) : null;
        const isUp      = livePnL == null ? true : livePnL >= 0;

        return (
          <div key={pos.id} className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-white">{pos.pair}</span>
                <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">
                  LONG
                </span>
                {isPending
                  ? <span className="text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full">PENDING FILL</span>
                  : pos.status === "chasing"
                    ? <span className="text-xs bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-full">
                        CHASING ${fmtPrice(pos.chase_price ?? 0, pos.pair)}
                      </span>
                    : <span className="text-xs text-gray-500">Hold {pos.hold_count}/{6}</span>
                }
              </div>
              <div className="text-gray-500 text-xs mt-1">
                {isPending
                  ? `Limit buy placed · qty ${pos.quantity ?? "?"}`
                  : <>
                      {pos.z_score != null && pos.z_score > 0 && (
                        <span className="text-blue-400 font-medium mr-2">
                          Signal +{(pos.z_score * 100).toFixed(3)}% spread
                        </span>
                      )}
                      <span>
                        Entry ${fmtPrice(pos.entry_price ?? 0, pos.pair)} · SL ${fmtPrice(pos.sl ?? 0, pos.pair)} · TP ${fmtPrice(pos.tp ?? 0, pos.pair)}
                      </span>
                    </>
                }
              </div>
            </div>
            <div className="text-right">
              {livePnL != null ? (
                <>
                  <p className={`font-semibold ${isUp ? "text-green-400" : "text-red-400"}`}>
                    {isUp ? "+" : ""}{livePnL.toFixed(2)} USDT
                  </p>
                  <p className={`text-xs ${isUp ? "text-green-500" : "text-red-500"}`}>
                    {isUp ? "+" : ""}{pct}%
                  </p>
                </>
              ) : (
                <p className="text-gray-500 text-sm">waiting…</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
