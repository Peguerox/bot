-- One owner row is authoritative; both legs use its shared entry permission.
-- NULL means both optional filters are OFF, preserving existing entry behavior.
ALTER TABLE public.lighter_btc_optimal_state
  ADD COLUMN IF NOT EXISTS override_hedge_entry_filters JSONB;

NOTIFY pgrst, 'reload schema';
