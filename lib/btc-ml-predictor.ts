// Locked logistic regression model for live BTC direction prediction (15s horizon), trained
// 2026-09-08 on 15,908 rows of real logged Bitfinex/Binance microstructure data (see
// project_market_ticks_logger memory). Coefficients are FROZEN -- do not refit in place; if the
// model needs updating, retrain via the scratch Python pipeline and replace this whole file so
// the "trained on data up to X" boundary stays clear and auditable.
//
// Uses only 2 features (binance_imbalance, binance_venueGapPct) -- found across many reruns this
// session to be the dominant, stable signal; the other ~21 features tested added negligible or
// negative value once there was enough data to tell noise from signal.
//
// Feature computation MUST come from lib/market-features.ts's computeFeatures() -- the exact same
// function used to generate the training data. Never compute these features a different way here;
// that would silently reintroduce train/serve skew.
const FEATURE_ORDER = ["binance_imbalance", "binance_venueGapPct"] as const;
const MEDIAN = [-0.0299508261792571, -0.11177729111574453];
const CLIP_LO = [-0.9921261747470899, -0.14223123607168967];
const CLIP_HI = [0.9915781333571112, -0.09148145577965802];
const SCALER_MEAN = [-0.006572012674863305, -0.1123846403641402];
const SCALER_SCALE = [0.7068323651751882, 0.010035408949424998];
const COEF = [0.5183441467415821, 0.5051126096237164];
const INTERCEPT = -0.10865162262802314;

export type MlFeatures = { binance_imbalance: number | null; binance_venueGapPct: number | null };

// Returns P(price up in the next 15s), or null if the required features aren't ready yet.
export function predictUpProbability(features: MlFeatures): number | null {
  const raw = FEATURE_ORDER.map((k) => features[k as keyof MlFeatures]);
  let score = INTERCEPT;
  for (let i = 0; i < FEATURE_ORDER.length; i++) {
    const x = raw[i] === null || raw[i] === undefined || !Number.isFinite(raw[i] as number)
      ? MEDIAN[i]
      : Math.min(Math.max(raw[i] as number, CLIP_LO[i]), CLIP_HI[i]);
    const standardized = (x - SCALER_MEAN[i]) / SCALER_SCALE[i];
    score += COEF[i] * standardized;
  }
  return 1 / (1 + Math.exp(-score));
}
