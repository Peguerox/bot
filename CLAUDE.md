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

- **Worker 1**: `server/lighter_stoch_dca_btc_initial.py` — LIVE real money. Stochastic BTC with a
  blanking period, an hourly schedule, and a self-lock. Tables: `lighter_btc_initial_*`.
  Self-lock unlock rule, **broken twice already, now pinned by a test**: *2 wins of any kind, OR 1
  literal TP.* That is `self_lock_require_tp_in_streak=False` +
  `self_lock_tp_unlocks_instantly=True`. Do not make a literal TP mandatory — that leaves the bot
  locked out indefinitely on a streak of non-TP greens.
- **Worker 2**: `server/lighter_hedge_dual_leg.py` — LIVE real money, and the one process that
  drives **two** sub-accounts. It runs two `StochBot` instances under one `asyncio.gather`: a LONG
  leg on Worker 2's account (`lighter_btc_optimal_*` tables) and a SHORT leg on Worker 3's account
  (`lighter_stoch_dca_btc_*` tables), reading `WORKER3_LIGHTER_*` env vars for the second set of
  credentials. Both legs enter together, the loser is cut at SL 0.03%, the winner rides a
  profit-lock trail with a breakeven floor under it.
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
in `BotConfig`, currently on for both hedge legs) — before that these workers had no lock at all,
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

- `server/*.py` — the live worker processes. **`server/stoch_bot_core.py` (~3.7k lines) holds all
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
3. **Reset** wipes both legs' trade history and rolls residual PnL into `seed_usd`. It **refuses
   (409) while either leg holds a position** — so the sequence is always Close Both → Reset. Before
   2026-09-30 the close button didn't exist on this panel at all, which made an open cycle
   impossible to either close or reset from the dashboard.

## Retiring a bot

1. Check its live state in Supabase first (`enabled`, open position, real balance) — if it's
   real money, close/flatten the position before touching code, same as any live worker.
2. Delete `server/<file>.ts`, `lib/<file>-db.ts`, `app/api/<bot>/*`.
3. Remove its panel function, state hooks, `load()` fetch entries, toggle/clear handlers, and
   realtime channel subscription from `app/page.tsx` — grep the bot's table-name prefix across
   `app/page.tsx` to find every reference before deleting.
4. Leave its `supabase/migrations/*.sql` file alone (historical record).
