-- ─────────────────────────────────────────────────────────────────────────────
-- fifteen platform — Supabase schema
-- Run this in Supabase Dashboard → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- transactions ─────────────────────────────────────────────────────────────────
create table if not exists public.transactions (
  id             uuid primary key default gen_random_uuid(),
  tx_ref         text unique not null,
  wallet_address text not null,
  ngn_amount     numeric(18,2) not null,
  usdc_amount    numeric(18,6) not null,
  fee_bps        int not null default 150,
  rate           numeric(18,4) not null,
  status         text not null default 'pending'
                   check (status in ('pending','verified','delivering','delivered','failed')),
  flw_tx_id      bigint,
  tx_hash        text,
  ip_hash        text,          -- hashed IP for analytics, not raw
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists trg_transactions_updated_at on public.transactions;
create trigger trg_transactions_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

-- transaction_logs ─────────────────────────────────────────────────────────────
create table if not exists public.transaction_logs (
  id             bigserial primary key,
  tx_ref         text not null references public.transactions(tx_ref) on delete cascade,
  level          text not null default 'info'
                   check (level in ('info','warn','error','debug')),
  message        text not null,
  meta           jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists idx_logs_tx_ref   on public.transaction_logs(tx_ref);
create index if not exists idx_logs_created  on public.transaction_logs(created_at desc);

-- analytics view ───────────────────────────────────────────────────────────────
create or replace view public.transaction_stats as
select
  count(*)                                        as total_count,
  count(*) filter (where status = 'delivered')    as delivered_count,
  count(*) filter (where status = 'failed')       as failed_count,
  count(*) filter (where status = 'pending'
                      or status = 'verified'
                      or status = 'delivering')   as pending_count,
  coalesce(sum(ngn_amount) filter (where status = 'delivered'), 0) as total_ngn_volume,
  coalesce(sum(usdc_amount) filter (where status = 'delivered'), 0) as total_usdc_volume,
  coalesce(avg(usdc_amount) filter (where status = 'delivered'), 0) as avg_usdc_per_tx
from public.transactions;

-- disputes view (failed or stuck pending > 30 min) ─────────────────────────────
create or replace view public.dispute_transactions as
select * from public.transactions
where status = 'failed'
   or (status in ('pending','verified','delivering') and created_at < now() - interval '30 minutes')
order by created_at desc;

-- Enable Supabase Realtime on both tables ──────────────────────────────────────
alter publication supabase_realtime add table public.transactions;
alter publication supabase_realtime add table public.transaction_logs;

-- RLS — service role bypasses RLS; anon cannot read ───────────────────────────
alter table public.transactions     enable row level security;
alter table public.transaction_logs enable row level security;

-- Admin users (authenticated via Supabase Auth) can read everything
create policy "admin read transactions"
  on public.transactions for select
  to authenticated using (true);

create policy "admin read logs"
  on public.transaction_logs for select
  to authenticated using (true);

-- Service role (backend) has full access — bypasses RLS automatically
