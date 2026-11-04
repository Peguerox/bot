-- Flip martingale panel settings (owner, 2026-11-04): override_params = the panel's settings (next sequence),
-- seq_params = the settings the open sequence started with, live_params = what the next sequence will use (readout).
alter table public.lighter_lit_flip_state add column if not exists override_params jsonb, add column if not exists seq_params jsonb, add column if not exists live_params jsonb;
alter table public.lighter_near_flip_state add column if not exists override_params jsonb, add column if not exists seq_params jsonb, add column if not exists live_params jsonb;
alter table public.lighter_sol_flip_state add column if not exists override_params jsonb, add column if not exists seq_params jsonb, add column if not exists live_params jsonb;
