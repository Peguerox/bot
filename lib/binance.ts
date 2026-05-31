const BASE = "https://api.binance.us/api/v3";

export async function getKlines(symbol: string, interval: string, limit: number) {
  const url = `${BASE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      "X-MBX-APIKEY": process.env.BINANCE_API_KEY!,
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const raw = await res.json();
  return raw.map((c: string[]) => ({
    time: Number(c[0]),
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

export async function getPrice(symbol: string): Promise<number> {
  const res = await fetch(`${BASE}/ticker/price?symbol=${symbol}`, {
    cache: "no-store",
  });
  const data = await res.json();
  return parseFloat(data.price);
}
