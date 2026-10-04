export type HedgeEntryFilters = {
  stochasticEnabled: boolean;
  stochasticWindow: number;
  stochasticLow: number;
  stochasticHigh: number;
  zscoreEnabled: boolean;
  zscoreWindow: number;
  zscoreLow: number;
  zscoreHigh: number;
  atrEnabled: boolean;
  atrWindow: number;
  atrPercentile: number;
  bandwidthEnabled: boolean;
  bandwidthWindow: number;
  bandwidthPercentile: number;
};

export const DEFAULT_HEDGE_ENTRY_FILTERS: HedgeEntryFilters = {
  stochasticEnabled: false, stochasticWindow: 5, stochasticLow: 25, stochasticHigh: 75,
  zscoreEnabled: false, zscoreWindow: 5, zscoreLow: -2, zscoreHigh: 2,
  atrEnabled: false, atrWindow: 10, atrPercentile: 80,
  bandwidthEnabled: false, bandwidthWindow: 20, bandwidthPercentile: 80,
};

export function validateHedgeEntryFilters(value: unknown): HedgeEntryFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Entry filters must be an object.");
  const v = value as Record<string, unknown>;
  const out = { ...DEFAULT_HEDGE_ENTRY_FILTERS };
  for (const key of Object.keys(out) as (keyof HedgeEntryFilters)[]) {
    // Older clients/configs contain the original eight fields. New gates default OFF.
    if ((key.startsWith("atr") || key.startsWith("bandwidth")) && v[key] === undefined) continue;
    if (key.endsWith("Enabled")) {
      if (typeof v[key] !== "boolean") throw new Error(`${key} must be true or false.`);
    } else if (typeof v[key] !== "number" || !Number.isFinite(v[key])) {
      throw new Error(`${key} must be a finite number.`);
    }
    Object.assign(out, { [key]: v[key] });
  }
  for (const w of [out.stochasticWindow, out.zscoreWindow, out.atrWindow, out.bandwidthWindow]) {
    if (!Number.isInteger(w) || w < 2 || w > 50) throw new Error("Windows must be whole numbers from 2 to 50.");
  }
  if (!(0 <= out.stochasticLow && out.stochasticLow < out.stochasticHigh && out.stochasticHigh <= 100)) {
    throw new Error("Stochastic needs 0 ≤ Low < High ≤ 100.");
  }
  if (!(out.zscoreLow >= -20 && out.zscoreLow < 0 && out.zscoreHigh > 0 && out.zscoreHigh <= 20)) {
    throw new Error("Z-score Low must be negative and High positive, between -20 and 20.");
  }
  for (const p of [out.atrPercentile, out.bandwidthPercentile]) {
    if (p < 1 || p > 99) throw new Error("ATR and BandWidth percentiles must be from 1 to 99.");
  }
  return out;
}
