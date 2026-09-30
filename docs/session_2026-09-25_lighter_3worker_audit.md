# Lighter BTC 3-Worker Session Summary — 2026-09-25/26

## Current live configs

### Worker 1 — "Blanking Period + Hourly Schedule"
File: `server/lighter_stoch_dca_btc_initial.py`
- Base: window 5, entry/reversal 25/75, TP 0.10%, SL 0.11% (identical to Worker 2's base)
- `reversal_guard_seconds=120` — the "blanking period": ignore an opposite signal until the
  position is 120s old. TP/SL always fire immediately regardless (confirmed on real data: 16
  of the last 35 real TPs closed under 120s after opening).
- `trading_hours_utc` — hourly schedule, open hours ET: 12am-1am, 5am-7am, 8am-9am, 11am-6pm
  (biggest block), 8pm-10pm. 3am-4am ET was closed 2026-09-25 (real data showed it turned
  negative both live workers that hour, despite being positive in the original fitting data).
- No session breaker, no self-lock.

### Worker 2 — "Combined"
File: `server/lighter_stoch_dca_btc_optimal.py`. Activated 2026-09-25, replacing the old
no-gates baseline (archived at `lighter_stoch_dca_btc_optimal_PREV_no_gates.py.bak`).
- Same base signal + all of: blanking period, hourly schedule, self-lock, plus a new
  **hour-open confirmation**: at the start of every open-hour window (including right after a
  restart if booted mid-open-hour), real entries stay paused until the paper shadow posts 1
  win (TP or, since 2026-09-26, a winning reversal too).
- `self_lock_reversal_counts_as_win=True` (added 2026-09-26) — literal-TP-only was too strict,
  confirmed live sitting 90+ minutes without a clean TP despite favorable price action. Now a
  winning paper reversal satisfies both the self-lock unlock AND the hour-open confirmation.
- Bug fixed 2026-09-26: hour-open confirmation was re-arming on every restart even while a
  real position was already open (caught live — a deploy landed 42s after a real entry and
  incorrectly re-armed the gate). Fixed: skips arming entirely if a real position is open,
  since the whole point is "don't enter blind," which doesn't apply once already positioned.
- Migrations run: `lighter_btc_optimal_self_lock.sql`,
  `lighter_btc_optimal_hour_open_confirmation.sql`.
- Balance reset 2026-09-25 to the real account balance ($97.68) with realized_pnl_usd zeroed
  — a clean start, not an inflated one.

### Worker 3 — "Self-Lock"
File: `server/lighter_stoch_dca_btc_bot.py`
- Same base signal + `reversal_guard_seconds=120` + self-lock (real SL locks real trading,
  2-in-a-row paper wins unlock).
- `self_lock_reversal_counts_as_win=True` (added 2026-09-25) — broadened from literal-TP-only
  after re-testing on 79.9h of real data flipped the earlier (smaller-sample) finding:
  literal-TP-only +1.663% (231 trades, 60.6% win) vs broadened +2.327% (473 trades, 62.6%
  win, higher maxDD $1.56 vs $1.44).
- No hourly schedule (kept intentionally different from Worker 2 for comparison).
- User's originally-intended rule was actually stricter ("1 TP + 1 reversal-win, OR 2 TPs",
  and a losing reversal should reset the count) — what's deployed is looser (any 2 wins of
  either kind, losing reversals stay neutral). Left as-is to observe; the exact-as-specified
  version can be built later to compare if this one doesn't hold up.

## Key backtest findings (real tick data, EXECUTION_LATENCY_MS=1400 throughout)

- **Full 75-83h of real tick data**, baseline (no gates): net negative to slightly positive
  depending on exact window (-$0.64 to +$1.28), consistently the worst of any variant tested.
- **Combined config (blanking+hours+self-lock+hour-open) vs each alone**, full 75h: baseline
  -$0.64; Worker 1 alone (blanking+hours) -- underperformed live despite backtest; Worker 3
  alone (self-lock) +$1.11; blanking alone +$0.06 (near-flat); combined +$2.65 (best
  drawdown, $0.97, but less raw return than hours-only alone).
- **Hours-only alone backtests far better than combined** (+$7.84 vs +$2.65) but this is
  in-sample (schedule was fit to the same data) — the live counter-evidence is Worker 1
  (hours+blanking, no self-lock) losing real money on 2026-09-25 despite the rosy backtest.
  Self-lock's live adaptiveness is the reasoning for keeping the combined config despite
  testing weaker in-sample.
- **SL 0.11% vs SL 0.10%** (tighter, symmetric with TP): current 0.11% clearly better
  (+$1.28/58.8% win vs +$0.46/56.3% win over the same 83h) — the asymmetric band is doing
  real work, left as-is.
- **Self-lock reversal-counting**: flipped between an earlier ~45h test (literal-TP-only won)
  and the later ~80h test (broadened rule won) — a reminder that small-sample backtest
  conclusions here don't always hold as more data comes in.

## Bugs found and fixed this session

1. **WAF/CAPTCHA reliability**: Worker 1 had two real incidents (one ~44min burst on
   2026-09-25 tied to two back-to-back deploys landing ~4min apart; a second cluster of 1,162
   failed reads spread across several hours the same day, concentrated in heavy-deploy
   windows). Root cause confirmed NOT a missing auth token (Worker 2/3 had zero failures on
   the same restarts) — most likely restart-timing/request-volume overlap. Self-resolves via
   the existing backoff, no money lost (one trade got relabeled `EXTERNAL` with correct PnL).
   Lesson: avoid stacking multiple deploys close together when possible.
2. **Hour-open confirmation footgun**: `hour_open_requires_paper_tp=True` without
   `self_lock_enabled` would permanently lock out real entries (nothing would ever clear the
   flag). Guarded against in code before it could ever be misconfigured live.
3. **Hour-open confirmation re-arming with an open position** (see Worker 2 section above).
4. **Dashboard display gap**: the Self-Lock pill only showed `real_trading_locked`, so Worker 2
   looked "active" while actually blocked by the separate hour-open confirmation gate —
   confusing live. Fixed: `awaiting_open_confirmation` now persisted and shown as "awaiting
   win" (amber) on the pill.
5. **Dashboard layout**: Worker 2 has 5 potential pills (equity, win rate, position, self-lock,
   trading hours) which didn't fit a clean 2x2 like the other workers — added a
   `combineEquityWinRate` option, used only on Worker 2, merging equity+win-rate into one pill
   and fixing the grid order to [Equity/WinRate, Self-Lock] / [Position, Trading Hours].

## Other dashboard changes
- Trade-list rows and the Trading Hours badge now show times in Miami/Eastern (not UTC).
- Short-side labels changed from red to amber (red was double-duty for "short" and "loss").
- Position pill now shows a progress bar + % toward TP, and unrealized $ now shows % next to it.
- "Show Summary" button and its entirely Surfer-specific comparison table removed (dead code
  after both Surfer bots were disabled/archived).
- Both Surfer bots (SOL/USDT rotation, SOL/BTC buffered rotation) disabled and archived
  2026-09-25 — full specs in `docs/archive/live-bot-surfer-{solusdt-v1,solbtc-v2}.ts.txt`,
  Trigger.dev crons actually unregistered (not just local file deletes).

## Infrastructure notes
- Lighter Premium account tier (~$500 in staked LIT) would give 24,000 req/min vs Standard's
  60 req/min, likely fixing the WAF issue for good -- but introduces real trading fees
  (~0.028% taker at minimum stake) that would eat over half the 0.10% TP margin per trade on
  hundreds of daily trades. Not worth it for this strategy; staying on Standard (0% fees).
- Render redeploys all 3 backend services on every push, regardless of which one changed --
  worth batching commits instead of pushing repeatedly when possible.

## Test suite
254 tests passing in `server/test_core.py` as of the end of this session (started at 234).
