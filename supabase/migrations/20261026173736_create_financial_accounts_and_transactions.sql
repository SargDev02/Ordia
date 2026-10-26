create table public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  account_type text not null,
  currency text not null default 'COP',
  initial_balance bigint not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_accounts_name_check check (char_length(btrim(name)) between 1 and 80),
  constraint financial_accounts_type_check check (account_type in ('cash', 'bank', 'wallet')),
  constraint financial_accounts_currency_check check (currency = 'COP'),
  constraint financial_accounts_initial_balance_check check (initial_balance between -9000000000000 and 9000000000000)
);

create table public.financial_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null,
  account_id uuid not null references public.financial_accounts (id) on delete restrict,
  destination_account_id uuid references public.financial_accounts (id) on delete restrict,
  amount bigint not null,
  occurred_on date not null default ((now() at time zone 'America/Bogota')::date),
  category text,
  description text,
  client_request_id uuid not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_transactions_kind_check check (kind in ('income', 'expense', 'transfer')),
  constraint financial_transactions_amount_check check (amount between 1 and 9000000000000),
  constraint financial_transactions_description_check check (description is null or char_length(description) <= 240),
  constraint financial_transactions_shape_check check (
    (
      kind = 'income'
      and destination_account_id is null
      and category is not null
      and category in ('salary', 'extra_income', 'returns', 'other_income')
    )
    or
    (
      kind = 'expense'
      and destination_account_id is null
      and category is not null
      and category in ('food', 'housing', 'transport', 'health', 'education', 'entertainment', 'utilities', 'shopping', 'other_expense')
    )
    or
    (
      kind = 'transfer'
      and destination_account_id is not null
      and destination_account_id <> account_id
      and category is null
    )
  ),
  constraint financial_transactions_request_unique unique (user_id, client_request_id)
);

create index financial_accounts_user_id_idx on public.financial_accounts (user_id);
create index financial_transactions_user_date_idx on public.financial_transactions (user_id, occurred_on desc);
create index financial_transactions_account_idx on public.financial_transactions (account_id);
create index financial_transactions_destination_idx on public.financial_transactions (destination_account_id)
where destination_account_id is not null;

create or replace function public.set_financial_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.validate_financial_account()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.name = btrim(new.name);

  if tg_op = 'INSERT' and new.archived_at is not null then
    raise exception 'New accounts cannot be created as archived'
      using errcode = '23514';
  elsif tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.currency is distinct from old.currency
      or new.created_at is distinct from old.created_at then
      raise exception 'Account identity, owner, currency and creation date are immutable'
        using errcode = '23514';
    end if;

    if old.archived_at is not null and new.archived_at is distinct from old.archived_at then
      raise exception 'An archived account cannot be reactivated'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.validate_financial_transaction()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_owner uuid;
  source_currency text;
  source_archived_at timestamptz;
  destination_owner uuid;
  destination_currency text;
  destination_archived_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.client_request_id is distinct from old.client_request_id
      or new.created_at is distinct from old.created_at then
      raise exception 'Transaction identity, owner, request id and creation date are immutable'
        using errcode = '23514';
    end if;

    if old.deleted_at is not null then
      raise exception 'A deleted transaction cannot be changed'
        using errcode = '23514';
    end if;

    if new.deleted_at is not null then
      if new.kind is distinct from old.kind
        or new.account_id is distinct from old.account_id
        or new.destination_account_id is distinct from old.destination_account_id
        or new.amount is distinct from old.amount
        or new.occurred_on is distinct from old.occurred_on
        or new.category is distinct from old.category
        or new.description is distinct from old.description then
        raise exception 'Deleting a transaction cannot modify its financial fields'
          using errcode = '23514';
      end if;
      return new;
    end if;
  elsif new.deleted_at is not null then
    raise exception 'New transactions cannot be created as deleted'
      using errcode = '23514';
  end if;

  new.description = nullif(btrim(new.description), '');

  perform 1
  from public.financial_accounts as account
  where account.id in (new.account_id, new.destination_account_id)
  order by account.id
  for update;

  select account.user_id, account.currency, account.archived_at
    into source_owner, source_currency, source_archived_at
  from public.financial_accounts as account
  where account.id = new.account_id
  ;

  if not found then
    raise exception 'Source account does not exist' using errcode = '23503';
  end if;
  if source_owner is distinct from new.user_id then
    raise exception 'Source account does not belong to the transaction owner' using errcode = '42501';
  end if;
  if source_archived_at is not null
    and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id) then
    raise exception 'Archived accounts do not accept new transactions' using errcode = '23514';
  end if;

  if new.kind = 'transfer' then
    if new.destination_account_id = new.account_id then
      raise exception 'Transfer accounts must be different' using errcode = '23514';
    end if;

    select account.user_id, account.currency, account.archived_at
      into destination_owner, destination_currency, destination_archived_at
    from public.financial_accounts as account
    where account.id = new.destination_account_id
    ;

    if not found then
      raise exception 'Destination account does not exist' using errcode = '23503';
    end if;
    if destination_owner is distinct from new.user_id then
      raise exception 'Destination account does not belong to the transaction owner' using errcode = '42501';
    end if;
    if destination_currency is distinct from source_currency then
      raise exception 'Transfer accounts must use the same currency' using errcode = '23514';
    end if;
    if destination_archived_at is not null
      and (tg_op = 'INSERT' or new.destination_account_id is distinct from old.destination_account_id) then
      raise exception 'Archived accounts do not accept new transactions' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.set_financial_updated_at() from public, anon, authenticated;
revoke execute on function public.validate_financial_account() from public, anon, authenticated;
revoke execute on function public.validate_financial_transaction() from public, anon, authenticated;

create trigger financial_accounts_validate_before_write
before insert or update on public.financial_accounts
for each row execute function public.validate_financial_account();

create trigger financial_accounts_set_updated_at
before update on public.financial_accounts
for each row execute function public.set_financial_updated_at();

create trigger financial_transactions_validate_before_write
before insert or update on public.financial_transactions
for each row execute function public.validate_financial_transaction();

create trigger financial_transactions_set_updated_at
before update on public.financial_transactions
for each row execute function public.set_financial_updated_at();

alter table public.financial_accounts enable row level security;
alter table public.financial_transactions enable row level security;

revoke all on table public.financial_accounts from anon, authenticated;
revoke all on table public.financial_transactions from anon, authenticated;
grant select, insert, update on table public.financial_accounts to authenticated;
grant select, insert, update on table public.financial_transactions to authenticated;

create policy "Users select own financial accounts"
on public.financial_accounts for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users insert own financial accounts"
on public.financial_accounts for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users update own financial accounts"
on public.financial_accounts for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users select own financial transactions"
on public.financial_transactions for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users insert own financial transactions"
on public.financial_transactions for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users update own financial transactions"
on public.financial_transactions for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create or replace function public.create_financial_transaction(
  p_request_id uuid,
  p_kind text,
  p_account_id uuid,
  p_destination_account_id uuid,
  p_amount bigint,
  p_occurred_on date,
  p_category text,
  p_description text
)
returns public.financial_transactions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  result public.financial_transactions;
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  insert into public.financial_transactions (
    user_id,
    client_request_id,
    kind,
    account_id,
    destination_account_id,
    amount,
    occurred_on,
    category,
    description
  ) values (
    current_user_id,
    p_request_id,
    p_kind,
    p_account_id,
    p_destination_account_id,
    p_amount,
    p_occurred_on,
    p_category,
    p_description
  )
  on conflict (user_id, client_request_id) do nothing
  returning * into result;

  if result.id is null then
    select transaction.* into result
    from public.financial_transactions as transaction
    where transaction.user_id = current_user_id
      and transaction.client_request_id = p_request_id;
  end if;

  return result;
end;
$$;

revoke execute on function public.create_financial_transaction(uuid, text, uuid, uuid, bigint, date, text, text) from public, anon;
grant execute on function public.create_financial_transaction(uuid, text, uuid, uuid, bigint, date, text, text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'financial_accounts'
  ) then
    alter publication supabase_realtime add table public.financial_accounts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'financial_transactions'
  ) then
    alter publication supabase_realtime add table public.financial_transactions;
  end if;
end;
$$;
