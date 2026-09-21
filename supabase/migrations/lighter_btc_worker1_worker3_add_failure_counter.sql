alter table lighter_btc_initial_state
  add column if not exists consecutive_entry_failures integer not null default 0;
update lighter_btc_initial_state set consecutive_entry_failures = 0 where id = 1;

alter table lighter_stoch_dca_btc_state
  add column if not exists consecutive_entry_failures integer not null default 0;
update lighter_stoch_dca_btc_state set consecutive_entry_failures = 0 where id = 1;
