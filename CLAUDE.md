@AGENTS.md

# Deploying this project

This is a personal crypto trading bot dashboard + two always-on Bitfinex workers. Read this
before touching deploy/infra so you don't have to rediscover it each time.

## Live infrastructure (hard cap: 2 Render workers, see feedback_worker_budget memory)

- **Worker 1**: runs `server/sol-dca-bitfinex.ts` — SOL DCA-martingale, LIVE real money.
- **Worker 2**: runs `server/sol-hypertrade-paper.ts` — SOL hypertrading continuous-grid DCA,
  PAPER only (unlimited sizing, real bid/ask fills, no real orders).

Both are Render services whose Start Command is `npx tsx server/<file>.ts`. **There is no Render
API/CLI access from this environment** — changing which file a worker runs means the user has to
manually update that worker's Start Command in the Render dashboard. I can't do it.

Each worker uses a Supabase-row lock (`lock_owner`/`lock_heartbeat` columns on its `*_state`
table) so a redeploy's new instance won't fight the dying old one. `LOCK_STALE_MS` must stay
noticeably above `HEARTBEAT_MS` (currently 15s vs 10s) — too tight caused a real crash-loop once
where every fresh instance saw the just-killed instance's heartbeat as still "fresh" and refused
to start. See git log for "crash loop" if this happens again.

## Deploying code changes

1. `git push origin main` — this repo **is** a real git repo (`github.com/Peguerox/bot`),
   pushing to `main` triggers Render's auto-deploy for whichever worker(s) import changed files.
   Render deploy does NOT change a worker's Start Command — only redeploys what's already
   configured to run.
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

- `server/*.ts` — the actual live worker processes. If a file here isn't one of the two Start
  Commands above, it's dead code left over from a retired strategy — check before assuming it's
  live (dashboard panels can outlive the worker that fed them).
- `lib/*-config.ts` — shared strategy constants (DCA%, multiplier, TP%, seed, etc.), imported by
  both the worker and the dashboard panel. Always add new constants here, never hardcode the same
  number in both places — that's how dashboard/worker drift happens.
- `lib/*-db.ts` — Supabase read/write helpers per strategy.
- `app/page.tsx` — the whole dashboard, one file, one panel function per bot.
- `app/api/<bot>/{toggle,clear-history}/route.ts` — the only two mutating endpoints per bot.
- `supabase/migrations/*.sql` — schema history, kept even for retired strategies (audit trail).
- `research/` — excluded from the TypeScript project (see tsconfig.json `exclude`). Ad-hoc
  backtest/analysis scripts and cached data go here, never in the repo root. Nothing under
  `research/` should ever be imported by live code.
- `backtest/`, `trigger/` — separate, already-organized areas (trigger.dev surfer bots, backtest
  strategy scripts), also excluded from the main TS project.

## Retiring a bot

1. Check its live state in Supabase first (`enabled`, open position, real balance) — if it's
   real money, close/flatten the position before touching code, same as any live worker.
2. Delete `server/<file>.ts`, `lib/<file>-db.ts`, `app/api/<bot>/*`.
3. Remove its panel function, state hooks, `load()` fetch entries, toggle/clear handlers, and
   realtime channel subscription from `app/page.tsx` — grep the bot's table-name prefix across
   `app/page.tsx` to find every reference before deleting.
4. Leave its `supabase/migrations/*.sql` file alone (historical record).
