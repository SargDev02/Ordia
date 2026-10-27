create table public.fixed_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_request_id uuid not null,
  name text not null,
  notes text,
  status text not null default 'active',
  paused_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fixed_expenses_name_check check (char_length(btrim(name)) between 1 and 100),
  constraint fixed_expenses_notes_check check (notes is null or char_length(notes) <= 500),
  constraint fixed_expenses_status_check check (status in ('active', 'paused', 'deleted')),
  constraint fixed_expenses_status_shape_check check (
    (status = 'active' and paused_at is null and deleted_at is null)
    or (status = 'paused' and paused_at is not null and deleted_at is null)
    or (status = 'deleted' and deleted_at is not null)
  ),
  constraint fixed_expenses_request_unique unique (user_id, client_request_id)
);

create table public.fixed_expense_versions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  fixed_expense_id uuid not null references public.fixed_expenses (id) on delete restrict,
  effective_from date not null,
  expected_amount bigint not null,
  currency text not null default 'COP',
  category_id uuid not null references public.financial_categories (id) on delete restrict,
  suggested_account_id uuid references public.financial_accounts (id) on delete restrict,
  frequency text not null,
  anchor_date date not null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint fixed_expense_versions_amount_check check (expected_amount between 1 and 9000000000000),
  constraint fixed_expense_versions_currency_check check (currency = 'COP'),
  constraint fixed_expense_versions_frequency_check check (frequency in ('monthly', 'annual'))
);

create unique index fixed_expense_versions_active_effective_unique
on public.fixed_expense_versions (fixed_expense_id, effective_from)
where superseded_at is null;

create table public.fixed_expense_periods (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  fixed_expense_id uuid not null references public.fixed_expenses (id) on delete restrict,
  version_id uuid not null references public.fixed_expense_versions (id) on delete restrict,
  due_date date not null,
  expected_amount bigint not null,
  currency text not null default 'COP',
  category_id uuid not null references public.financial_categories (id) on delete restrict,
  suggested_account_id uuid references public.financial_accounts (id) on delete restrict,
  transaction_id uuid unique references public.financial_transactions (id) on delete restrict,
  payment_request_id uuid,
  paid_amount bigint,
  paid_on date,
  paid_account_id uuid references public.financial_accounts (id) on delete restrict,
  paid_category_id uuid references public.financial_categories (id) on delete restrict,
  paid_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fixed_expense_periods_amount_check check (expected_amount between 1 and 9000000000000),
  constraint fixed_expense_periods_paid_amount_check check (paid_amount is null or paid_amount between 1 and 9000000000000),
  constraint fixed_expense_periods_currency_check check (currency = 'COP'),
  constraint fixed_expense_periods_cancellation_check check (
    (cancelled_at is null and cancellation_reason is null)
    or (cancelled_at is not null and cancellation_reason in ('paused', 'deleted', 'superseded'))
  ),
  constraint fixed_expense_periods_due_unique unique (fixed_expense_id, due_date),
  constraint fixed_expense_periods_payment_shape_check check (
    (
      transaction_id is null and payment_request_id is null and paid_amount is null
      and paid_on is null and paid_account_id is null and paid_category_id is null and paid_at is null
    )
    or
    (
      transaction_id is not null and payment_request_id is not null and paid_amount is not null
      and paid_on is not null and paid_account_id is not null and paid_category_id is not null and paid_at is not null
      and cancelled_at is null
    )
  )
);

create unique index fixed_expense_periods_payment_request_unique
on public.fixed_expense_periods (user_id, payment_request_id)
where payment_request_id is not null;

create index fixed_expenses_user_status_idx on public.fixed_expenses (user_id, status);
create index fixed_expense_versions_user_expense_idx on public.fixed_expense_versions (user_id, fixed_expense_id, effective_from);
create index fixed_expense_versions_category_idx on public.fixed_expense_versions (category_id);
create index fixed_expense_versions_suggested_account_idx on public.fixed_expense_versions (suggested_account_id)
where suggested_account_id is not null;
create index fixed_expense_periods_user_due_pending_idx on public.fixed_expense_periods (user_id, due_date)
where transaction_id is null and cancelled_at is null;
create index fixed_expense_periods_expense_idx on public.fixed_expense_periods (fixed_expense_id, due_date desc);
create index fixed_expense_periods_version_idx on public.fixed_expense_periods (version_id);
create index fixed_expense_periods_category_idx on public.fixed_expense_periods (category_id);
create index fixed_expense_periods_suggested_account_idx on public.fixed_expense_periods (suggested_account_id)
where suggested_account_id is not null;
create index fixed_expense_periods_paid_account_idx on public.fixed_expense_periods (paid_account_id)
where paid_account_id is not null;
create index fixed_expense_periods_paid_category_idx on public.fixed_expense_periods (paid_category_id)
where paid_category_id is not null;

create or replace function public.fixed_expense_due_date(
  p_anchor_date date,
  p_frequency text,
  p_occurrence integer
)
returns date
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  target_month date;
  last_day date;
  original_day integer := extract(day from p_anchor_date)::integer;
begin
  if p_occurrence < 0 then
    raise exception 'Occurrence must not be negative' using errcode = '22023';
  end if;

  if p_frequency = 'monthly' then
    target_month := (date_trunc('month', p_anchor_date)::date + make_interval(months => p_occurrence))::date;
  elsif p_frequency = 'annual' then
    target_month := make_date(
      extract(year from p_anchor_date)::integer + p_occurrence,
      extract(month from p_anchor_date)::integer,
      1
    );
  else
    raise exception 'Unsupported fixed expense frequency' using errcode = '22023';
  end if;

  last_day := (target_month + interval '1 month - 1 day')::date;
  return make_date(
    extract(year from target_month)::integer,
    extract(month from target_month)::integer,
    least(original_day, extract(day from last_day)::integer)
  );
end;
$$;

create or replace function public.validate_fixed_expense()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_setting('ordia.fixed_expense_flow', true) is distinct from 'on' then
    raise exception 'Fixed expenses must be changed through their dedicated operations' using errcode = '42501';
  end if;

  new.name := btrim(new.name);
  new.notes := nullif(btrim(new.notes), '');

  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.client_request_id is distinct from old.client_request_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Fixed expense identity, owner, request id and creation date are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_fixed_expense_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  expense_owner uuid;
  category_owner uuid;
  category_kind text;
  category_archived timestamptz;
  account_owner uuid;
  account_archived timestamptz;
begin
  if current_setting('ordia.fixed_expense_flow', true) is distinct from 'on' then
    raise exception 'Fixed expense versions must be changed through their dedicated operations' using errcode = '42501';
  end if;

  select user_id into expense_owner from public.fixed_expenses where id = new.fixed_expense_id;
  if not found or expense_owner is distinct from new.user_id then
    raise exception 'Fixed expense does not belong to the version owner' using errcode = '42501';
  end if;

  select user_id, kind, archived_at into category_owner, category_kind, category_archived
  from public.financial_categories where id = new.category_id;
  if not found or category_owner is distinct from new.user_id then
    raise exception 'Category does not belong to the version owner' using errcode = '42501';
  end if;
  if category_kind <> 'expense' then
    raise exception 'Fixed expenses require an expense category' using errcode = '23514';
  end if;
  if category_archived is not null and (tg_op = 'INSERT' or new.category_id is distinct from old.category_id) then
    raise exception 'Archived categories cannot be assigned to future obligations' using errcode = '23514';
  end if;

  if new.suggested_account_id is not null then
    select user_id, archived_at into account_owner, account_archived
    from public.financial_accounts where id = new.suggested_account_id;
    if not found or account_owner is distinct from new.user_id then
      raise exception 'Suggested account does not belong to the version owner' using errcode = '42501';
    end if;
    if account_archived is not null and (tg_op = 'INSERT' or new.suggested_account_id is distinct from old.suggested_account_id) then
      raise exception 'Archived accounts cannot be suggested for future obligations' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id or new.user_id is distinct from old.user_id
    or new.fixed_expense_id is distinct from old.fixed_expense_id
    or new.effective_from is distinct from old.effective_from
    or new.expected_amount is distinct from old.expected_amount
    or new.currency is distinct from old.currency
    or new.category_id is distinct from old.category_id
    or new.suggested_account_id is distinct from old.suggested_account_id
    or new.frequency is distinct from old.frequency
    or new.anchor_date is distinct from old.anchor_date
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Only version supersession can be changed' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_fixed_expense_period()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  expense_owner uuid;
  version_owner uuid;
  version_expense uuid;
  category_owner uuid;
  category_kind text;
  suggested_account_owner uuid;
  paid_account_owner uuid;
  payment_owner uuid;
  payment_kind text;
  payment_account_id uuid;
  payment_amount bigint;
  payment_date date;
  payment_category_id uuid;
  payment_deleted_at timestamptz;
begin
  if current_setting('ordia.fixed_expense_flow', true) is distinct from 'on' then
    raise exception 'Fixed expense periods must be changed through their dedicated operations' using errcode = '42501';
  end if;

  select user_id into expense_owner from public.fixed_expenses where id = new.fixed_expense_id;
  select user_id, fixed_expense_id into version_owner, version_expense from public.fixed_expense_versions where id = new.version_id;
  if expense_owner is distinct from new.user_id or version_owner is distinct from new.user_id
    or version_expense is distinct from new.fixed_expense_id then
    raise exception 'Period references do not belong to the period owner' using errcode = '42501';
  end if;

  select user_id, kind into category_owner, category_kind
  from public.financial_categories where id = new.category_id;
  if not found or category_owner is distinct from new.user_id then
    raise exception 'Period category does not belong to the period owner' using errcode = '42501';
  end if;
  if category_kind <> 'expense' then
    raise exception 'Fixed expense periods require an expense category' using errcode = '23514';
  end if;

  if new.suggested_account_id is not null then
    select user_id into suggested_account_owner
    from public.financial_accounts where id = new.suggested_account_id;
    if not found or suggested_account_owner is distinct from new.user_id then
      raise exception 'Suggested account does not belong to the period owner' using errcode = '42501';
    end if;
  end if;

  if new.transaction_id is not null then
    select user_id, kind, account_id, amount, occurred_on, category_id, deleted_at
      into payment_owner, payment_kind, payment_account_id, payment_amount,
        payment_date, payment_category_id, payment_deleted_at
    from public.financial_transactions where id = new.transaction_id;
    if not found or payment_owner is distinct from new.user_id then
      raise exception 'Payment transaction does not belong to the period owner' using errcode = '42501';
    end if;
    select user_id into paid_account_owner from public.financial_accounts where id = new.paid_account_id;
    if not found or paid_account_owner is distinct from new.user_id then
      raise exception 'Paid account does not belong to the period owner' using errcode = '42501';
    end if;
    if payment_kind <> 'expense' or payment_account_id is distinct from new.paid_account_id
      or payment_amount is distinct from new.paid_amount or payment_date is distinct from new.paid_on
      or payment_category_id is distinct from new.paid_category_id or payment_deleted_at is not null then
      raise exception 'Payment transaction must exactly match the fixed expense payment' using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id or new.user_id is distinct from old.user_id
    or new.fixed_expense_id is distinct from old.fixed_expense_id
    or new.due_date is distinct from old.due_date or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Period identity, owner, recurrence and creation date are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.protect_fixed_expense_payment_transaction()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_setting('ordia.fixed_payment_flow', true) is distinct from 'on'
    and exists (
      select 1 from public.fixed_expense_periods
      where transaction_id = old.id and user_id = old.user_id
    ) then
    raise exception 'Recurring payments must be changed from the fixed expense flow' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fixed_expense_due_date(date, text, integer) from public, anon;
revoke execute on function public.validate_fixed_expense() from public, anon, authenticated;
revoke execute on function public.validate_fixed_expense_version() from public, anon, authenticated;
revoke execute on function public.validate_fixed_expense_period() from public, anon, authenticated;
revoke execute on function public.protect_fixed_expense_payment_transaction() from public, anon, authenticated;
grant execute on function public.fixed_expense_due_date(date, text, integer) to authenticated;

create trigger fixed_expenses_validate_before_write
before insert or update on public.fixed_expenses
for each row execute function public.validate_fixed_expense();
create trigger fixed_expenses_set_updated_at
before update on public.fixed_expenses
for each row execute function public.set_financial_updated_at();

create trigger fixed_expense_versions_validate_before_write
before insert or update on public.fixed_expense_versions
for each row execute function public.validate_fixed_expense_version();

create trigger fixed_expense_periods_validate_before_write
before insert or update on public.fixed_expense_periods
for each row execute function public.validate_fixed_expense_period();
create trigger fixed_expense_periods_set_updated_at
before update on public.fixed_expense_periods
for each row execute function public.set_financial_updated_at();

create trigger financial_transactions_protect_fixed_payments
before update on public.financial_transactions
for each row execute function public.protect_fixed_expense_payment_transaction();

alter table public.fixed_expenses enable row level security;
alter table public.fixed_expense_versions enable row level security;
alter table public.fixed_expense_periods enable row level security;

revoke all on table public.fixed_expenses from anon, authenticated;
revoke all on table public.fixed_expense_versions from anon, authenticated;
revoke all on table public.fixed_expense_periods from anon, authenticated;
grant select, insert, update on table public.fixed_expenses to authenticated;
grant select, insert, update on table public.fixed_expense_versions to authenticated;
grant select, insert, update on table public.fixed_expense_periods to authenticated;

create policy "Users select own fixed expenses" on public.fixed_expenses for select to authenticated
using ((select auth.uid()) = user_id);
create policy "Users insert own fixed expenses" on public.fixed_expenses for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy "Users update own fixed expenses" on public.fixed_expenses for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Users select own fixed expense versions" on public.fixed_expense_versions for select to authenticated
using ((select auth.uid()) = user_id);
create policy "Users insert own fixed expense versions" on public.fixed_expense_versions for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy "Users update own fixed expense versions" on public.fixed_expense_versions for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Users select own fixed expense periods" on public.fixed_expense_periods for select to authenticated
using ((select auth.uid()) = user_id);
create policy "Users insert own fixed expense periods" on public.fixed_expense_periods for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy "Users update own fixed expense periods" on public.fixed_expense_periods for update to authenticated
using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.generate_fixed_expense_periods(p_horizon_months integer default 3)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  today date := (now() at time zone 'America/Bogota')::date;
  horizon_date date;
  version_record record;
  occurrence integer;
  due_date_value date;
  inserted_count integer := 0;
  affected integer;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_horizon_months not between 1 and 12 then
    raise exception 'Horizon must be between 1 and 12 months' using errcode = '22023';
  end if;
  horizon_date := (today + make_interval(months => p_horizon_months))::date;
  perform set_config('ordia.fixed_expense_flow', 'on', true);

  for version_record in
    select version.*, (
      select min(next_version.effective_from)
      from public.fixed_expense_versions as next_version
      where next_version.fixed_expense_id = version.fixed_expense_id
        and next_version.superseded_at is null
        and next_version.effective_from > version.effective_from
    ) as next_effective_from
    from public.fixed_expense_versions as version
    join public.fixed_expenses as expense on expense.id = version.fixed_expense_id
    where version.user_id = current_user_id
      and version.superseded_at is null
      and expense.status = 'active'
    order by version.fixed_expense_id, version.effective_from
  loop
    for occurrence in 0..1200 loop
      due_date_value := public.fixed_expense_due_date(version_record.anchor_date, version_record.frequency, occurrence);
      if due_date_value < version_record.effective_from then
        continue;
      end if;
      exit when version_record.next_effective_from is not null and due_date_value >= version_record.next_effective_from;
      exit when due_date_value > horizon_date;

      insert into public.fixed_expense_periods (
        user_id, fixed_expense_id, version_id, due_date, expected_amount,
        currency, category_id, suggested_account_id
      ) values (
        current_user_id, version_record.fixed_expense_id, version_record.id, due_date_value,
        version_record.expected_amount, version_record.currency, version_record.category_id,
        version_record.suggested_account_id
      )
      on conflict (fixed_expense_id, due_date) do update
      set version_id = excluded.version_id,
          expected_amount = excluded.expected_amount,
          currency = excluded.currency,
          category_id = excluded.category_id,
          suggested_account_id = excluded.suggested_account_id,
          cancelled_at = null,
          cancellation_reason = null
      where fixed_expense_periods.cancellation_reason = 'superseded'
        and fixed_expense_periods.transaction_id is null;
      get diagnostics affected = row_count;
      inserted_count := inserted_count + affected;
    end loop;
  end loop;
  return inserted_count;
end;
$$;

create or replace function public.create_fixed_expense(
  p_request_id uuid,
  p_name text,
  p_expected_amount bigint,
  p_category_id uuid,
  p_suggested_account_id uuid,
  p_frequency text,
  p_first_due_date date,
  p_notes text
)
returns public.fixed_expenses
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  result public.fixed_expenses;
begin
  if current_user_id is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  perform set_config('ordia.fixed_expense_flow', 'on', true);

  insert into public.fixed_expenses (user_id, client_request_id, name, notes)
  values (current_user_id, p_request_id, p_name, p_notes)
  on conflict (user_id, client_request_id) do nothing
  returning * into result;

  if result.id is null then
    select * into result from public.fixed_expenses
    where user_id = current_user_id and client_request_id = p_request_id;
    return result;
  end if;

  insert into public.fixed_expense_versions (
    user_id, fixed_expense_id, effective_from, expected_amount, category_id,
    suggested_account_id, frequency, anchor_date
  ) values (
    current_user_id, result.id, p_first_due_date, p_expected_amount, p_category_id,
    p_suggested_account_id, p_frequency, p_first_due_date
  );
  perform public.generate_fixed_expense_periods(3);
  return result;
end;
$$;

create or replace function public.update_fixed_expense(
  p_fixed_expense_id uuid,
  p_name text,
  p_expected_amount bigint,
  p_category_id uuid,
  p_suggested_account_id uuid,
  p_frequency text,
  p_anchor_date date,
  p_effective_from date,
  p_notes text
)
returns public.fixed_expenses
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  today date := (now() at time zone 'America/Bogota')::date;
  result public.fixed_expenses;
begin
  if p_effective_from < today then
    raise exception 'Changes cannot rewrite overdue obligations' using errcode = '23514';
  end if;
  select * into result from public.fixed_expenses
  where id = p_fixed_expense_id and user_id = current_user_id for update;
  if not found then raise exception 'Fixed expense does not exist' using errcode = '23503'; end if;
  if result.status = 'deleted' then raise exception 'Deleted fixed expenses cannot be changed' using errcode = '23514'; end if;
  perform set_config('ordia.fixed_expense_flow', 'on', true);

  update public.fixed_expenses set name = p_name, notes = p_notes
  where id = p_fixed_expense_id returning * into result;
  update public.fixed_expense_versions set superseded_at = now()
  where fixed_expense_id = p_fixed_expense_id and superseded_at is null
    and effective_from >= p_effective_from;
  update public.fixed_expense_periods set cancelled_at = now(), cancellation_reason = 'superseded'
  where fixed_expense_id = p_fixed_expense_id and due_date >= p_effective_from
    and transaction_id is null and cancelled_at is null;
  insert into public.fixed_expense_versions (
    user_id, fixed_expense_id, effective_from, expected_amount, category_id,
    suggested_account_id, frequency, anchor_date
  ) values (
    current_user_id, p_fixed_expense_id, p_effective_from, p_expected_amount,
    p_category_id, p_suggested_account_id, p_frequency, p_anchor_date
  );
  if result.status = 'active' then perform public.generate_fixed_expense_periods(3); end if;
  return result;
end;
$$;

create or replace function public.pause_fixed_expense(p_fixed_expense_id uuid)
returns public.fixed_expenses
language plpgsql security invoker set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  today date := (now() at time zone 'America/Bogota')::date;
  result public.fixed_expenses;
begin
  select * into result from public.fixed_expenses where id = p_fixed_expense_id and user_id = current_user_id for update;
  if not found then raise exception 'Fixed expense does not exist' using errcode = '23503'; end if;
  if result.status <> 'active' then raise exception 'Only active fixed expenses can be paused' using errcode = '23514'; end if;
  perform set_config('ordia.fixed_expense_flow', 'on', true);
  update public.fixed_expenses set status = 'paused', paused_at = now() where id = p_fixed_expense_id returning * into result;
  update public.fixed_expense_periods set cancelled_at = now(), cancellation_reason = 'paused'
  where fixed_expense_id = p_fixed_expense_id and due_date >= today
    and transaction_id is null and cancelled_at is null;
  return result;
end;
$$;

create or replace function public.reactivate_fixed_expense(p_fixed_expense_id uuid, p_next_due_date date)
returns public.fixed_expenses
language plpgsql security invoker set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  today date := (now() at time zone 'America/Bogota')::date;
  result public.fixed_expenses;
  latest_version public.fixed_expense_versions;
begin
  if p_next_due_date < today then raise exception 'Next due date cannot be in the past' using errcode = '23514'; end if;
  select * into result from public.fixed_expenses where id = p_fixed_expense_id and user_id = current_user_id for update;
  if not found then raise exception 'Fixed expense does not exist' using errcode = '23503'; end if;
  if result.status <> 'paused' then raise exception 'Only paused fixed expenses can be reactivated' using errcode = '23514'; end if;
  select * into latest_version from public.fixed_expense_versions
  where fixed_expense_id = p_fixed_expense_id and superseded_at is null
  order by effective_from desc limit 1;
  perform set_config('ordia.fixed_expense_flow', 'on', true);
  update public.fixed_expense_versions set superseded_at = now()
  where fixed_expense_id = p_fixed_expense_id and superseded_at is null and effective_from >= p_next_due_date;
  insert into public.fixed_expense_versions (
    user_id, fixed_expense_id, effective_from, expected_amount, category_id,
    suggested_account_id, frequency, anchor_date
  ) values (
    current_user_id, p_fixed_expense_id, p_next_due_date, latest_version.expected_amount,
    latest_version.category_id, latest_version.suggested_account_id,
    latest_version.frequency, p_next_due_date
  );
  update public.fixed_expense_periods
  set cancellation_reason = 'superseded'
  where fixed_expense_id = p_fixed_expense_id and due_date = p_next_due_date
    and transaction_id is null and cancellation_reason = 'paused';
  update public.fixed_expenses set status = 'active', paused_at = null where id = p_fixed_expense_id returning * into result;
  perform public.generate_fixed_expense_periods(3);
  return result;
end;
$$;

create or replace function public.delete_fixed_expense(p_fixed_expense_id uuid)
returns public.fixed_expenses
language plpgsql security invoker set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  today date := (now() at time zone 'America/Bogota')::date;
  result public.fixed_expenses;
begin
  select * into result from public.fixed_expenses where id = p_fixed_expense_id and user_id = current_user_id for update;
  if not found then raise exception 'Fixed expense does not exist' using errcode = '23503'; end if;
  if result.status = 'deleted' then return result; end if;
  perform set_config('ordia.fixed_expense_flow', 'on', true);
  update public.fixed_expenses set status = 'deleted', deleted_at = now() where id = p_fixed_expense_id returning * into result;
  update public.fixed_expense_periods set cancelled_at = now(), cancellation_reason = 'deleted'
  where fixed_expense_id = p_fixed_expense_id and due_date >= today
    and transaction_id is null and cancelled_at is null;
  return result;
end;
$$;

create or replace function public.pay_fixed_expense_period(
  p_period_id uuid,
  p_request_id uuid,
  p_account_id uuid,
  p_category_id uuid,
  p_paid_on date,
  p_amount bigint
)
returns public.financial_transactions
language plpgsql security invoker set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  period_record public.fixed_expense_periods;
  expense_name text;
  result public.financial_transactions;
begin
  select * into period_record from public.fixed_expense_periods
  where id = p_period_id and user_id = current_user_id for update;
  if not found then raise exception 'Fixed expense period does not exist' using errcode = '23503'; end if;
  if period_record.cancelled_at is not null then raise exception 'Cancelled obligations cannot be paid' using errcode = '23514'; end if;
  if period_record.transaction_id is not null then
    if period_record.payment_request_id = p_request_id then
      select * into result from public.financial_transactions where id = period_record.transaction_id;
      return result;
    end if;
    raise exception 'This obligation is already paid' using errcode = '23505';
  end if;
  select name into expense_name from public.fixed_expenses where id = period_record.fixed_expense_id;
  perform set_config('ordia.fixed_expense_flow', 'on', true);
  perform set_config('ordia.fixed_payment_flow', 'on', true);

  insert into public.financial_transactions (
    user_id, client_request_id, kind, account_id, destination_account_id,
    amount, occurred_on, category_id, description
  ) values (
    current_user_id, p_request_id, 'expense', p_account_id, null,
    p_amount, p_paid_on, p_category_id, expense_name
  )
  on conflict (user_id, client_request_id) do nothing
  returning * into result;
  if result.id is null then
    select * into result from public.financial_transactions
    where user_id = current_user_id and client_request_id = p_request_id;
  end if;

  update public.fixed_expense_periods
  set transaction_id = result.id, payment_request_id = p_request_id,
      paid_amount = p_amount, paid_on = p_paid_on, paid_account_id = p_account_id,
      paid_category_id = p_category_id, paid_at = now()
  where id = p_period_id;
  return result;
end;
$$;

create or replace function public.undo_fixed_expense_payment(p_period_id uuid)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  period_record public.fixed_expense_periods;
begin
  select * into period_record from public.fixed_expense_periods
  where id = p_period_id and user_id = current_user_id for update;
  if not found then raise exception 'Fixed expense period does not exist' using errcode = '23503'; end if;
  if period_record.transaction_id is null then raise exception 'This obligation is not paid' using errcode = '23514'; end if;
  perform set_config('ordia.fixed_expense_flow', 'on', true);
  perform set_config('ordia.fixed_payment_flow', 'on', true);
  update public.financial_transactions set deleted_at = now()
  where id = period_record.transaction_id and user_id = current_user_id and deleted_at is null;
  if not found then raise exception 'Linked payment movement is unavailable' using errcode = '23514'; end if;
  update public.fixed_expense_periods
  set transaction_id = null, payment_request_id = null, paid_amount = null,
      paid_on = null, paid_account_id = null, paid_category_id = null, paid_at = null
  where id = p_period_id;
end;
$$;

revoke execute on function public.generate_fixed_expense_periods(integer) from public, anon;
revoke execute on function public.create_fixed_expense(uuid, text, bigint, uuid, uuid, text, date, text) from public, anon;
revoke execute on function public.update_fixed_expense(uuid, text, bigint, uuid, uuid, text, date, date, text) from public, anon;
revoke execute on function public.pause_fixed_expense(uuid) from public, anon;
revoke execute on function public.reactivate_fixed_expense(uuid, date) from public, anon;
revoke execute on function public.delete_fixed_expense(uuid) from public, anon;
revoke execute on function public.pay_fixed_expense_period(uuid, uuid, uuid, uuid, date, bigint) from public, anon;
revoke execute on function public.undo_fixed_expense_payment(uuid) from public, anon;
grant execute on function public.generate_fixed_expense_periods(integer) to authenticated;
grant execute on function public.create_fixed_expense(uuid, text, bigint, uuid, uuid, text, date, text) to authenticated;
grant execute on function public.update_fixed_expense(uuid, text, bigint, uuid, uuid, text, date, date, text) to authenticated;
grant execute on function public.pause_fixed_expense(uuid) to authenticated;
grant execute on function public.reactivate_fixed_expense(uuid, date) to authenticated;
grant execute on function public.delete_fixed_expense(uuid) to authenticated;
grant execute on function public.pay_fixed_expense_period(uuid, uuid, uuid, uuid, date, bigint) to authenticated;
grant execute on function public.undo_fixed_expense_payment(uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'fixed_expenses'
  ) then alter publication supabase_realtime add table public.fixed_expenses; end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'fixed_expense_versions'
  ) then alter publication supabase_realtime add table public.fixed_expense_versions; end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'fixed_expense_periods'
  ) then alter publication supabase_realtime add table public.fixed_expense_periods; end if;
end;
$$;
