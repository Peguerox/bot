-- Tight-TP self-lock paper test (2026-09-26): Worker 3 shadow-tests the same self-lock
-- mechanism it runs for real, but at TP 0.05% / SL 0.05% instead of 0.10%/0.11%, entirely on
-- paper. Two layers persisted: an inner shadow (tight_paper_*) that decides lock/unlock, and
-- an outer simulated position (tight_sim_*) that only trades while unlocked -- see
-- stoch_bot_core.py's BotConfig docstring. Never touches real money.

alter table lighter_stoch_dca_btc_state
  add column if not exists tight_paper_side text,
  add column if not exists tight_paper_entry_price double precision,
  add column if not exists tight_paper_entry_time bigint,
  add column if not exists tight_paper_consecutive_tps integer not null default 0,
  add column if not exists tight_real_locked boolean not null default false,
  add column if not exists tight_sim_side text,
  add column if not exists tight_sim_entry_price double precision,
  add column if not exists tight_sim_entry_time bigint;

create table if not exists lighter_btc_tight_tp_paper_trades (
  id bigint generated always as identity primary key,
  worker_id text not null,
  side text not null,
  entry_price double precision not null,
  exit_price double precision not null,
  pnl_pct double precision not null,
  reason text not null,
  opened_at timestamptz not null,
  closed_at timestamptz not null default now()
);

alter publication supabase_realtime add table public.lighter_btc_tight_tp_paper_trades;

alter table public.lighter_btc_tight_tp_paper_trades enable row level security;

create policy "anon_read" on public.lighter_btc_tight_tp_paper_trades for select to anon using (true);
