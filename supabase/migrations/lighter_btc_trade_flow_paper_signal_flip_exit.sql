-- Trade-flow paper trade "signal-flip exit" (2026-10-12, same day, direct request after a real
-- Paper 1 trade went green then rode the ratio's full reversal back down into an SL loss: "if
-- you are positive and the signal flips, getting out early... we would have won that one").
-- Threshold mode only. Default OFF (NULL) -- zero behavior change until turned on.

alter table public.lighter_btc_initial_state
  add column if not exists override_trade_flow_paper_signal_flip_exit boolean;

alter table public.lighter_btc_worker4_state
  add column if not exists override_trade_flow_paper_signal_flip_exit boolean;
