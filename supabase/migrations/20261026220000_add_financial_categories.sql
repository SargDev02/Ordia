create table public.financial_categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null,
  parent_id uuid references public.financial_categories (id) on delete restrict,
  name text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_categories_kind_check check (kind in ('income', 'expense')),
  constraint financial_categories_name_check check (char_length(btrim(name)) between 1 and 60)
);

create unique index financial_categories_root_name_unique
on public.financial_categories (user_id, kind, lower(btrim(name)))
where parent_id is null;

create unique index financial_categories_child_name_unique
on public.financial_categories (user_id, kind, parent_id, lower(btrim(name)))
where parent_id is not null;

create index financial_categories_user_kind_idx
on public.financial_categories (user_id, kind, archived_at);

create index financial_categories_parent_idx
on public.financial_categories (parent_id)
where parent_id is not null;

create or replace function public.validate_financial_category()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  parent_owner uuid;
  parent_kind text;
  parent_parent_id uuid;
  parent_archived_at timestamptz;
begin
  new.name = btrim(new.name);

  if tg_op = 'INSERT' and new.archived_at is not null then
    raise exception 'New categories cannot be created as archived' using errcode = '23514';
  elsif tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.kind is distinct from old.kind
      or new.parent_id is distinct from old.parent_id
      or new.created_at is distinct from old.created_at then
      raise exception 'Category identity, owner, type, parent and creation date are immutable'
        using errcode = '23514';
    end if;

    if old.archived_at is not null and new.archived_at is distinct from old.archived_at then
      raise exception 'An archived category cannot be reactivated' using errcode = '23514';
    end if;
  end if;

  if new.parent_id is not null then
    select category.user_id, category.kind, category.parent_id, category.archived_at
      into parent_owner, parent_kind, parent_parent_id, parent_archived_at
    from public.financial_categories as category
    where category.id = new.parent_id;

    if not found then
      raise exception 'Parent category does not exist' using errcode = '23503';
    end if;
    if parent_owner is distinct from new.user_id then
      raise exception 'Parent category does not belong to the category owner' using errcode = '42501';
    end if;
    if parent_kind is distinct from new.kind then
      raise exception 'Parent and child categories must have the same type' using errcode = '23514';
    end if;
    if parent_parent_id is not null then
      raise exception 'Financial categories support only two levels' using errcode = '23514';
    end if;
    if parent_archived_at is not null and tg_op = 'INSERT' then
      raise exception 'Archived categories cannot receive new subcategories' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.archive_financial_category_children()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.archived_at is null and new.archived_at is not null and new.parent_id is null then
    update public.financial_categories
    set archived_at = new.archived_at
    where user_id = new.user_id
      and parent_id = new.id
      and archived_at is null;
  end if;
  return null;
end;
$$;

revoke execute on function public.validate_financial_category() from public, anon, authenticated;
revoke execute on function public.archive_financial_category_children() from public, anon, authenticated;

create trigger financial_categories_validate_before_write
before insert or update on public.financial_categories
for each row execute function public.validate_financial_category();

create trigger financial_categories_set_updated_at
before update on public.financial_categories
for each row execute function public.set_financial_updated_at();

create trigger financial_categories_archive_children_after_update
after update of archived_at on public.financial_categories
for each row execute function public.archive_financial_category_children();

alter table public.financial_categories enable row level security;

revoke all on table public.financial_categories from anon, authenticated;
grant select, insert, update on table public.financial_categories to authenticated;

create policy "Users select own financial categories"
on public.financial_categories for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users insert own financial categories"
on public.financial_categories for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users update own financial categories"
on public.financial_categories for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create or replace function public.ensure_default_financial_categories()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  insert into public.financial_categories (user_id, kind, name)
  values
    (current_user_id, 'income', 'Salario'),
    (current_user_id, 'income', 'Ingreso extra'),
    (current_user_id, 'income', 'Rendimientos'),
    (current_user_id, 'income', 'Otros ingresos'),
    (current_user_id, 'expense', 'Alimentación'),
    (current_user_id, 'expense', 'Vivienda'),
    (current_user_id, 'expense', 'Transporte'),
    (current_user_id, 'expense', 'Salud'),
    (current_user_id, 'expense', 'Educación'),
    (current_user_id, 'expense', 'Entretenimiento'),
    (current_user_id, 'expense', 'Servicios'),
    (current_user_id, 'expense', 'Compras'),
    (current_user_id, 'expense', 'Otros gastos')
  on conflict do nothing;
end;
$$;

revoke execute on function public.ensure_default_financial_categories() from public, anon;
grant execute on function public.ensure_default_financial_categories() to authenticated;

insert into public.financial_categories (user_id, kind, name)
select users.user_id, defaults.kind, defaults.name
from (
  select distinct user_id from public.financial_accounts
  union
  select distinct user_id from public.financial_transactions
) as users
cross join (values
  ('income', 'Salario'),
  ('income', 'Ingreso extra'),
  ('income', 'Rendimientos'),
  ('income', 'Otros ingresos'),
  ('expense', 'Alimentación'),
  ('expense', 'Vivienda'),
  ('expense', 'Transporte'),
  ('expense', 'Salud'),
  ('expense', 'Educación'),
  ('expense', 'Entretenimiento'),
  ('expense', 'Servicios'),
  ('expense', 'Compras'),
  ('expense', 'Otros gastos')
) as defaults(kind, name)
on conflict do nothing;

alter table public.financial_transactions
add column category_id uuid references public.financial_categories (id) on delete restrict;

drop trigger financial_transactions_validate_before_write on public.financial_transactions;

update public.financial_transactions as transaction
set category_id = category.id
from public.financial_categories as category
where transaction.kind in ('income', 'expense')
  and category.user_id = transaction.user_id
  and category.kind = transaction.kind
  and category.parent_id is null
  and category.name = case transaction.category
    when 'salary' then 'Salario'
    when 'extra_income' then 'Ingreso extra'
    when 'returns' then 'Rendimientos'
    when 'other_income' then 'Otros ingresos'
    when 'food' then 'Alimentación'
    when 'housing' then 'Vivienda'
    when 'transport' then 'Transporte'
    when 'health' then 'Salud'
    when 'education' then 'Educación'
    when 'entertainment' then 'Entretenimiento'
    when 'utilities' then 'Servicios'
    when 'shopping' then 'Compras'
    when 'other_expense' then 'Otros gastos'
  end;

do $$
begin
  if exists (
    select 1 from public.financial_transactions
    where kind in ('income', 'expense') and category_id is null
  ) then
    raise exception 'Some existing transactions could not be mapped to financial categories';
  end if;
end;
$$;

drop function public.create_financial_transaction(uuid, text, uuid, uuid, bigint, date, text, text);

alter table public.financial_transactions
drop constraint financial_transactions_shape_check,
drop column category;

alter table public.financial_transactions
add constraint financial_transactions_shape_check check (
  (
    kind in ('income', 'expense')
    and destination_account_id is null
    and category_id is not null
  )
  or
  (
    kind = 'transfer'
    and destination_account_id is not null
    and destination_account_id <> account_id
    and category_id is null
  )
);

create index financial_transactions_category_idx
on public.financial_transactions (category_id)
where category_id is not null;

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
  category_owner uuid;
  category_kind text;
  category_archived_at timestamptz;
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
      raise exception 'A deleted transaction cannot be changed' using errcode = '23514';
    end if;

    if new.deleted_at is not null then
      if new.kind is distinct from old.kind
        or new.account_id is distinct from old.account_id
        or new.destination_account_id is distinct from old.destination_account_id
        or new.amount is distinct from old.amount
        or new.occurred_on is distinct from old.occurred_on
        or new.category_id is distinct from old.category_id
        or new.description is distinct from old.description then
        raise exception 'Deleting a transaction cannot modify its financial fields'
          using errcode = '23514';
      end if;
      return new;
    end if;
  elsif new.deleted_at is not null then
    raise exception 'New transactions cannot be created as deleted' using errcode = '23514';
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
  where account.id = new.account_id;

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
    where account.id = new.destination_account_id;

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
  else
    select category.user_id, category.kind, category.archived_at
      into category_owner, category_kind, category_archived_at
    from public.financial_categories as category
    where category.id = new.category_id;

    if not found then
      raise exception 'Category does not exist' using errcode = '23503';
    end if;
    if category_owner is distinct from new.user_id then
      raise exception 'Category does not belong to the transaction owner' using errcode = '42501';
    end if;
    if category_kind is distinct from new.kind then
      raise exception 'Category type must match transaction type' using errcode = '23514';
    end if;
    if category_archived_at is not null
      and (tg_op = 'INSERT' or new.category_id is distinct from old.category_id) then
      raise exception 'Archived categories do not accept new transactions' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.validate_financial_transaction() from public, anon, authenticated;

create trigger financial_transactions_validate_before_write
before insert or update on public.financial_transactions
for each row execute function public.validate_financial_transaction();

create or replace function public.create_financial_transaction(
  p_request_id uuid,
  p_kind text,
  p_account_id uuid,
  p_destination_account_id uuid,
  p_amount bigint,
  p_occurred_on date,
  p_category_id uuid,
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
    user_id, client_request_id, kind, account_id, destination_account_id,
    amount, occurred_on, category_id, description
  ) values (
    current_user_id, p_request_id, p_kind, p_account_id, p_destination_account_id,
    p_amount, p_occurred_on, p_category_id, p_description
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

revoke execute on function public.create_financial_transaction(uuid, text, uuid, uuid, bigint, date, uuid, text) from public, anon;
grant execute on function public.create_financial_transaction(uuid, text, uuid, uuid, bigint, date, uuid, text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'financial_categories'
  ) then
    alter publication supabase_realtime add table public.financial_categories;
  end if;
end;
$$;
