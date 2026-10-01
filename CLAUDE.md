@AGENTS.md

# Deploying this project

This is a personal crypto trading bot dashboard (Next.js on Vercel) + always-on Python workers on
Render trading BTC on Lighter with **real money**. Read this before touching deploy/infra so you
don't have to rediscover it each time — and keep it current, because a stale version of this file
has repeatedly sent agents down the wrong path.

## Live infrastructure

The live fleet is **Python Lighter BTC bots**, not the TypeScript Bitfinex workers this section
used to describe (those are retired — see "Dead code" below). Rewritten 2026-09-30 after the
stale version of this file caused repeated drift.

**Before anything else: the project folder is `~/trading-bot`.** The GitHub repo and Vercel project
are both named "bot", but `~/Bot` (capital B, home folder) is an unrelated old May-2026 Python
project with no git/Render/Vercel link -- never work there.

- **Worker 1**: `server/lighter_stoch_dca_btc_initial.py` — LIVE real money, ~$98, tables
  `lighter_btc_initial_*`. As of 2026-10-01 (commit 1cbcb79):
  - **Entry:** a *fresh* stochastic signal (window 5, 25/75) AND the color-weighted balance index
    between **65 and 75** over 5 closed candles. The earlier zebra switch/size gate is disabled.
    One trade per signal (`profit_lock_burns_signal` + `red_exit_burns_signal`).
  - **Exits:** SL 0.10 / TP 0.10 / profit lock armed at +0.05% with **zero give-back** (exits on
    the first tick down), plus a stochastic reversal exit. Exchange-side native SL+TP orders on.
    User requested INDEX_EXIT removed on BOTH long and short positions on 2026-10-01:
    `index_exit_on_green=False`. The color-balance entry filter remains active.
  - **Off:** self-lock, hour ban (`trading_hours_utc=None`, `_WEEKDAY_SCHEDULE` kept in the file),
    dispersion filter, saving lock (`saving_lock_arm_frac_of_sl`, built 2026-10-01, available).
  - **Dashboard overrides win over the code**: `override_sl_pct / override_profit_lock_trigger /
    override_profit_lock_trail` on the state row (SL/Trigger/Trail boxes on the panel,
    `app/api/lighter-btc-initial-settings`). Always check them before believing the .py values.
  - Self-lock unlock rule, **broken twice already, pinned by a test**: *2 wins of any kind, OR 1
    literal TP* (`self_lock_require_tp_in_streak=False` + `self_lock_tp_unlocks_instantly=True`).
    Inert while self-lock is off; do not make a literal TP mandatory if it is turned back on.
  - Reset (`app/api/lighter-btc-initial-reset`) is **non-destructive**: stamps `history_reset_at`,
    rolls PnL into `seed_usd`, never deletes trades (they are the research data).
- **Worker 2**: `server/lighter_hedge_dual_leg.py` — LIVE real money, and the one process that
  drives **two** sub-accounts. It runs two `StochBot` instances under one `asyncio.gather`: a LONG
  leg on Worker 2's account (`lighter_btc_optimal_*` tables) and a SHORT leg on Worker 3's account
  (`lighter_stoch_dca_btc_*` tables), reading `WORKER3_LIGHTER_*` env vars for the second set of
  credentials. $10 per leg. As of 2026-10-01 (commit 3259e51):
  - **Entry:** both legs together whenever the 25/75 stochastic shows pressure
    (`require_pressure_to_enter`). On 2026-10-01 the user requested stochastic-only entries:
    both hedge legs have the color-balance min/max disabled. The numeric balance index still
    saves in entry snapshots for review. Exit overrides remain the user's dashboard settings.
    The dispersion floor / one-cycle-per-candle gates were built and
    then removed at the user's request (machinery still in the core, off).
  - **Exits:** loser cut at its SL; the winner's trail arms the instant the partner is cut
    (`partner_cut_arms_trail_immediately`). On 2026-10-01 the user requested a fixed **+0.03%**
    survivor floor (`fixed_partner_cut_floor_pct`) instead of the partner-loss-derived level.
    The trigger is relative to this leg's entry, applies only after the partner closes red,
    and does not guarantee the pair breaks even. The effective exit is max(peak − trail, floor);
    fills can pass the trigger. The existing BREAKEVEN_LOCK reason is retained for floor exits.
    Other bots keep the derived floor by default. The live SL/trigger/trail are the **dashboard
    overrides** (last seen SL 0.05 / trigger 0.10 / trail 0.04), not the 0.06/0.10/0.03 in the .py.
  - Production Reset is **non-destructive** as of 2026-10-01 (commit c78aaa3): preserves all
    trades, writes `history_reset_at` on each state
    row, carries equity forward, and requires both legs OFF/flat with no close pending.
    `supabase/migrations/lighter_hedge_reset_cutoff.sql` was applied by the user and both columns
    verified via REST. Dashboard deployed directly to Vercel and live code verified. No live
    reset has been performed. Audit commits were initially held locally while the hedge had
    open positions, then pushed with the snapshot repair after all accounts were OFF and flat.
    A later reset failure was traced to PostgreSQL float serialization: exact PnL equality
    matched neither unchanged row. Guards now allow only machine-rounding error (8 EPSILON
    scaled by balance), retain OFF/flat/close checks, and reject changes as small as $1e-10.
    Read-only production queries confirmed both guards match; 46 reset tests and TypeScript pass.
  - **Entry hover snapshot repair deployed (2026-10-01, commit b310441):**
    `compute_stoch_signal()` returns a direction string first, not numeric K. The old snapshot
    wrote `"long"`/`"short"` into DOUBLE PRECISION `entry_k`, rejecting the entire snapshot and
    leaving all four trade fields null. `compute_entry_stoch_k()` now computes numeric K without
    mutating the live signal; failed snapshot writes are logged. Hover formatting falls back to
    the other leg per field and explicitly labels missing historical snapshots. 656 worker
    checks + 75 dashboard/control tests pass. Both bots were confirmed OFF and all three
    exchange accounts flat before pushing. All three worker instances restarted, acquired
    locks, and had fresh heartbeats; the Vercel dashboard build passed. New numeric snapshots
    still need live confirmation on the first entries after the user resumes trading. No
    trading settings, signals, or exit rules changed. Do not push while workers are trading.
- **Worker 3**: its own Render service is **suspended**. Its sub-account is driven entirely from
  Worker 2's process. `server/lighter_stoch_dca_btc_bot.py` still works standalone if the hedge is
  ever abandoned — re-enable that service and disable the dual-leg one, no data migration needed.

Start Commands are `python server/<file>.py`. **There is no Render API/CLI access from this
environment** — changing which file a worker runs means the user has to manually update that
worker's Start Command in the Render dashboard. I can't do it.

Render redeploys **every** service on every push and does **not** stop the old container before
starting the new one, so two copies of a worker are alive together for ~30-60s on each deploy.
Batch commits into one push rather than pushing repeatedly.

### Single-instance lock

`lock_owner`/`lock_heartbeat` on the `*_state` row, so a redeploy's new instance won't fight the
dying old one. **This was added to the Python bots only on 2026-09-30** (`single_instance_lock`
in `BotConfig`, on for both hedge legs and, since 2026-10-01, Worker 1 -- after a deploy overlap
made Worker 1 enter twice and the oversize guard EMERGENCY_FLATTEN it) — before that these workers had no lock at all,
despite an earlier version of this file claiming they did, which is the root cause of the "zombie
double-entry" incident. The retired TS workers had their own copy
(`sol_dca_bitfinex_lock_columns.sql`).

The lock gates **new entries only, never exits** — an instance that loses the lock must still be
able to protect a position it already opened. `LOCK_STALE_AFTER` (20s) must stay well above
`LOCK_REFRESH_EVERY` (5s): too tight caused a real crash-loop once where every fresh instance saw
the just-killed instance's heartbeat as still "fresh" and refused to start. Note the lock has its
**own** refresh timer and deliberately does not ride `HEARTBEAT_EVERY` (300s) — at that cadence a
dead instance would hold the lock for over five minutes.

### Dead code

`server/sol-*.ts` (`sol-dca-bitfinex.ts`, `sol-hypertrade-paper.ts`) and the Surfer trigger.dev
bots are all retired. Nothing in `server/*.py` is dead except
`lighter_stoch_dca_btc_optimal.py` / `lighter_stoch_dca_btc_bot.py` (the pre-hedge Worker 2/3
single-account configs, kept deliberately as the revert path) and the `*.bak` file.

## Working with the user (read this)

- **Answer questions; don't act on them.** When he asks "what is this?" or "how could we improve
  X?", explain and stop. Only change code, push, flip settings or ask for SQL after he explicitly
  says to do it. He has had to say "don't do anything without telling me" more than once.
- When he *has* asked for a change, own the whole loop: tests → commit → push → Vercel deploy →
  confirm in Supabase that the worker restarted (`started` + `instance_lock_acquired` in
  `*_runs`) → report. Paste any SQL **into the chat** (he can't read file paths), and don't push
  a bot change that needs new columns until he says the SQL ran.
- He reads on a phone: short sentences, tables, no walls of text.
- Explicitly his call, never mine: clearing a self-lock, turning a bot ON.

## Deploying code changes

1. `git push origin main` — this repo **is** a real git repo (`github.com/Peguerox/bot`),
   pushing to `main` triggers Render's auto-deploy. Render redeploys **all** backend services on
   every push regardless of which files changed, so batch commits into a single push. Render
   deploy does NOT change a worker's Start Command — only redeploys what's already configured to
   run.
2. Dashboard (Vercel): `npx vercel --prod --yes --scope scrivano`. The `--scope scrivano` is
   required — the Vercel team's display name is "peguerox's projects" but its actual slug/ID is
   `scrivano`, and the CLI needs the slug. This project is linked to the **"bot"** Vercel project
   specifically (bot-pi-lemon.vercel.app) — there's an unrelated "scrivano-web" project in the
   same team, never touch that one. If `.vercel/project.json` is missing, link explicitly first:
   `npx vercel link --yes --project bot --scope scrivano`.

## Database (Supabase)

No `exec_sql` RPC exists in this project — DDL (new tables, ALTER TABLE) can't be applied via a
script. Write the migration as a `.sql` file in `supabase/migrations/`, send it to the user, and
they run it manually in the Supabase SQL Editor. DML (row reads/writes) can be done directly via
the REST API with the service role key from `.env.local`.

**Every new table needs RLS + an anon-read policy**, or the dashboard (which reads Supabase
directly with the anon key, not through API routes) gets empty results with no obvious error:

```sql
alter table public.<table> enable row level security;
create policy "anon_read" on public.<table> for select to anon using (true);
```

Writes (toggle enable/disable, clear-history) go through `app/api/*/route.ts` using the service
role key (`lib/supabase-admin.ts`), which bypasses RLS.

## Repo layout

- `server/*.py` — the live worker processes. **`server/stoch_bot_core.py` (~4.9k lines) holds all
  the shared logic**; each `lighter_*.py` file is settings only — a `BotConfig` plus a docstring
  recording why every setting is what it is. Behaviour changes go in the core behind a
  `BotConfig` flag defaulting to the old behaviour, so one bot's change can't silently alter
  another's. `server/test_core.py` is a plain script (`python3 test_core.py`, needs the Supabase
  env vars), not pytest.
  - **A `schema_has_*` flag gates both the READ and the WRITE of its columns.** A bot that leaves
    the flag False never writes those columns, so it must never read them either — a read without
    that guard picks up whatever a *previous* strategy left in the shared table. That exact bug
    gave the hedge short leg a 0.0909% stop instead of 0.03%.
- `server/*.ts` — all retired, see "Dead code" above.
- `lib/*-config.ts` — shared strategy constants for the TS-era bots. Always add new constants
  here, never hardcode the same number in both places — that's how dashboard/worker drift happens.
  The Python bots predate this convention and keep their constants in the `BotConfig`; the hedge
  panel's descriptive text in `app/page.tsx` is still hardcoded and has drifted from the bot's real
  numbers before, so check it against the config when changing either.
- `lib/*-db.ts` — Supabase read/write helpers per strategy.
- `app/page.tsx` — the whole dashboard, one file, one panel function per bot.
- `app/api/<bot>/{toggle,clear-history}/route.ts` — the only two mutating endpoints per bot.
- `supabase/migrations/*.sql` — schema history, kept even for retired strategies (audit trail).
- `research/` — excluded from the TypeScript project (see tsconfig.json `exclude`). Ad-hoc
  backtest/analysis scripts and cached data go here, never in the repo root. Nothing under
  `research/` should ever be imported by live code.
- `backtest/`, `trigger/` — separate, already-organized areas (trigger.dev surfer bots, backtest
  strategy scripts), also excluded from the main TS project.

## Worker 2 (hedge) dashboard controls

One panel, three buttons, all acting on **both** legs at once — `app/api/lighter-hedge-{toggle,
close,reset}`. The order matters and they interlock:

1. **ON/OFF** only blocks new entries. It never closes an open position.
2. **Close Both** sets `close_requested` on both state rows. Neither API route ever talks to the
   exchange — Lighter's signing SDK is Python-only, so the running worker picks the flag up on its
   next tick and closes through its own `close_all()`, retrying with backoff until REST confirms
   flat, then clears the flag and sets `enabled=false`.
3. **Reset** preserves both legs' trade history and rolls residual PnL into `seed_usd`.
   It filters displayed history by each leg's
   `history_reset_at`, and checks every read/update result. It requires both legs OFF and flat
   with no close pending; conditional updates reject concurrent balance/state changes. Updates
   are still separate, so a partial reset is reported explicitly (atomic updates remain an audit
   follow-up). `lighter_hedge_reset_cutoff.sql` is confirmed applied on both state tables.
   The sequence remains Close Both → wait for both legs OFF/flat → Reset. Before
   2026-09-30 the close button didn't exist on this panel at all, which made an open cycle
   impossible to either close or reset from the dashboard.

## Research findings so far (2026-10-01) -- don't redo these blind

Simulators + cached data: `research/sim-2026-10-01/` (git-ignored). `w1_bt.py` replays Worker 1's
rules on real Lighter 1-min candles (signals) + `lighter_btc_price_ticks` (exits, ~2.6s cadence,
so it slightly under-counts quick profit locks -- compare rows, don't trust exact dollars);
`hedge_bt.py` does the same for the hedge. Refresh ticks from `lighter_btc_price_ticks` (paginate
by id) and candles from the Lighter candles API (count_back=500, page by end_timestamp).

- Worker 1 SL width (0.05-0.25): no real difference -- a wider SL raises win rate but losses grow
  by the same amount. Every exit style tested lands near breakeven; the edge, if any, is in entries.
- Profit-lock give-back (trail 0.01-0.03): worse than zero give-back.
- Reversal-only exits (no SL/TP): worse, and one trade lost $1.84; no SL + reversal + TP: worst.
- Trend filter (efficiency ratio, against/with the 15-min move): no help -- fading a strong
  15-min move was actually the BEST group.
- Zebra / candle-size index (5 bars): a hill over 604 real trades, middle (≈600-1000) best, both
  ends lose. Borderline significance -- that's the live Worker 1 experiment now.
- Hedge: cycles opened at low 5-bar dispersion (< ~$30) carried most of the loss, but no gate made
  it profitable; the structural problem was the trail closing the winner below breakeven (fixed by
  Option B). Typical BTC "wiggle" ≈ $20-45 (0.02-0.05%): an exit tighter than ~0.04% is noise.

## Retiring a bot

1. Check its live state in Supabase first (`enabled`, open position, real balance) — if it's
   real money, close/flatten the position before touching code, same as any live worker.
2. Delete `server/<file>.ts`, `lib/<file>-db.ts`, `app/api/<bot>/*`.
3. Remove its panel function, state hooks, `load()` fetch entries, toggle/clear handlers, and
   realtime channel subscription from `app/page.tsx` — grep the bot's table-name prefix across
   `app/page.tsx` to find every reference before deleting.
4. Leave its `supabase/migrations/*.sql` file alone (historical record).
