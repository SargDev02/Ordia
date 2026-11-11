-- Ajustes independientes de ingresos/gastos; no cambia saldos iniciales ni filas existentes.
alter table public.financial_transactions
  add column adjustment_direction text,
  drop constraint financial_transactions_kind_check,
  drop constraint financial_transactions_shape_check,
  add constraint financial_transactions_kind_check check (kind in ('income','expense','transfer','adjustment')),
  add constraint financial_transactions_shape_check check (
    (kind in ('income','expense') and destination_account_id is null and category_id is not null and adjustment_direction is null)
    or (kind = 'transfer' and destination_account_id is not null and destination_account_id <> account_id and category_id is null and adjustment_direction is null)
    or (kind = 'adjustment' and destination_account_id is null and category_id is null and adjustment_direction is not null and adjustment_direction in ('increase','decrease'))
  );

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
        or new.adjustment_direction is distinct from old.adjustment_direction
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
  elsif new.kind in ('income', 'expense') then
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

-- RPC propia: mantiene compatible la firma usada por pagos y avisos bancarios.
create function public.create_balance_adjustment(
  p_request_id uuid, p_account_id uuid, p_direction text, p_amount bigint,
  p_occurred_on date, p_description text
)
returns public.financial_transactions
language plpgsql security invoker set search_path = ''
as $$
declare
  result public.financial_transactions;
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  insert into public.financial_transactions(
    user_id,client_request_id,kind,account_id,adjustment_direction,amount,occurred_on,description
  ) values (current_user_id,p_request_id,'adjustment',p_account_id,p_direction,p_amount,p_occurred_on,p_description)
  on conflict (user_id,client_request_id) do nothing returning * into result;
  if result.id is null then
    select t.* into result from public.financial_transactions t
    where t.user_id=current_user_id and t.client_request_id=p_request_id;
  end if;
  return result;
end;
$$;
revoke all on function public.create_balance_adjustment(uuid,uuid,text,bigint,date,text) from public,anon;
grant execute on function public.create_balance_adjustment(uuid,uuid,text,bigint,date,text) to authenticated;
