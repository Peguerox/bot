# SOL hypertrading formula — good news / bad news summary for the research agent

Plain summary of everything we've found testing the variable-rate DCA-martingale formula and its
alternatives, organized as good news (why we trust the deployed formula) and bad news (real
failure modes we found in other candidates, so they don't get re-proposed blind). Ends with the
open questions we still need answered. All figures are zero-commission (this account's real
Bitfinex fee tier) unless marked otherwise.

## Good news — the deployed "Original" formula

1. **Zero closed losses, every independent test we ran ourselves**: Bitfinex live 2yr SOL/USD,
   Binance Global 5yr SOL/USDT, and even 25yr of daily KO and AAPL (non-crypto, just to see if the
   mechanism breaks on trending assets — it didn't break, it just underperforms buy-and-hold
   there, see bad news below). Every cycle the formula opened, it eventually closed in profit.
2. **Self-sufficient compounding**: base bet recalculated each cycle as
   `(seed + realized P&L) / RESERVE_DIVISOR`. Never needed outside capital in any backtest,
   including the $10,000-compounding run, as long as the reserve divisor matches or exceeds the
   real-world worst-case depth.
3. **Max depth ever reached was level 9** on both trusted exchanges (Bitfinex 2yr, Binance Global
   5yr) — consistent across two independent datasets, not a one-off.
4. **Coefficient-perturbation robustness: 0/48 failures.** Nudging the formula's own coefficients
   (multiplier decay, drop-gap growth, TP shrink rate) by ±1% in all 48 joint combinations, same
   start date — none of them broke the strategy (ran out of cash). This is the test that exposed
   the "faster sizing" and "earlier 254%" variants as fragile (see bad news).
5. **Start-date sensitivity: 0/57 failures at reserve level 35x** (19 different historical start
   dates × 3 execution conventions, per the external research) — the unmodified formula doesn't
   care when you start running it, at this reserve level. This is the test that exposed the
   two-stage formula as fragile (see bad news).
6. **We independently reproduced a version of the start-date check ourselves** (not the same
   methodology — single execution convention, 20 evenly-spaced dates across the 5yr Binance
   Global set, not their 19 dates/3 conventions) and also found 0/20 failures at every reserve
   level tested (25.3517x / 30x / 31x / 35x). Two independently-built test harnesses agree.
7. **Reserve dial behaves exactly as expected mechanically**: more reserve → smaller first bet →
   lower ROI but deeper survival. No surprises once fully reconciled (25.3517x bare → 334.31% ROI,
   survives to level 9 with zero cushion; 35x deployed → 189.76% ROI, survives to level 11).

## Bad news — real failure modes found in other candidates (so we don't re-propose them)

1. **"Faster sizing" variants (higher multiplier growth) are fragile**: 34/48 and 42/48
   coefficient-perturbation failures despite the highest headline ROI we tested (343.33% and
   299.50%). The extra return comes from being closer to the edge of running out of cash, not
   from a genuinely better mechanism.
2. **The earlier "254%" variant is also fragile**: 18/48 coefficient failures. Real improvement
   on paper (254.01% vs the original's 232.38%, same H31 reserve), real fragility underneath.
3. **The two-stage sizing formula looked excellent on ROI and drawdown** (269.90%/239.03% at
   comparable reserve, beating the original on both return AND nominal drawdown) **but fails the
   start-date test badly**: 29/57 cash-failures at H26/H28/H30, and still 3/57 even at the deepest
   reserve tested (H35). This is the clearest example we found of a formula that passes one
   robustness axis (its own coefficients are fine, nothing to perturb it against) while failing
   the other (it's sensitive to *when* you start it) — a failure mode the coefficient-perturbation
   test alone would never have caught.
4. **The "adaptive" variant (market-condition-responsive sizing) fails outright at zero
   commission** — runs out of cash on 2022-01-21. Its headline 321.16% ROI only exists at a 0.1%
   commission assumption, which isn't this account's real fee tier. Disqualified regardless of any
   return number; also 21/48 coefficient failures on top of that.
5. **The mechanism doesn't generalize to trending assets.** Run unmodified on 25yr of daily KO and
   AAPL: zero closed losses on either, but buy-and-hold crushes the strategy (KO: buy-and-hold
   +250% vs strategy +35.7%; AAPL: buy-and-hold +107,539% vs strategy +86.0%). This is a
   mean-reversion/oscillation harvester — it needs a range-bound or cyclical asset, not a trending
   one. Not a bug, just a scope limit worth being explicit about.
6. **Binance US needs dramatically more capital** than the two trusted exchanges — 26 levels /
   $12,981 per $100 base bet vs 9 levels / $2,535 on Bitfinex and Binance Global, and got stuck in
   a position for 9.4 months in one run. Known liquidity problems on that venue; excluded from
   every sizing/robustness decision, not used as evidence either way on the formula itself.
7. **A real methodology bug we caught and fixed along the way**: an earlier version of our DCA-add
   slippage calculation had the sign backwards for buy fills (`price*(1-slip%)` instead of
   `price*(1+slip%)`), which gave artificially favorable DCA prices. Fixed; re-ran affected
   configs; the numbers changed materially in some windows, so this wasn't cosmetic. Flagging in
   case any of the externally-reported numbers we're comparing against have the same class of bug
   — we have no way to check their code, only their results.

## Open questions for the research agent

We still don't have answers to these, and they matter for deciding whether to trust the two-stage
formula's near-misses or push the original's reserve any further:

1. **What's the original formula's own start-date result at H30** (not H35)? We only have H31 and
   H35 confirmed at 0/57 for the original. H30 is the reserve that gives the best return-per-unit-
   of-cushion after H25.3517 bare, and we don't have its start-date sensitivity number.
2. **What are the exact 19 start dates used** in the 57-run test? We'd like to run the same 19
   dates through our own independent engine as a direct cross-check, not just our own 20
   evenly-spaced ones.
3. **Full breakdown of the two-stage formula's 3/57 near-misses at H35**: which of the 19
   dates/conventions failed, and by how much (ran out of cash on the Nth level, or just barely —
   e.g. failed needing a 12th level when 11 were funded)? If the near-misses are one or two
   outlier dates clustered around a specific historical event, that's a different risk profile
   than if they're spread evenly across the dataset.
4. **Does any source have real historical Bitfinex bid/ask spread data**, or is everyone (us
   included) still using a 0.02%/side proxy on top of Binance SOL/USDT price history? This is the
   single biggest open assumption across every number in this whole investigation.
