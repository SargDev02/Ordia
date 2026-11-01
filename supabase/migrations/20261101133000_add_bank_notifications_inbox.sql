-- Migración: Bandeja privada «Movimientos por revisar» y enlaces de tarjetas/cuentas
-- Proyecto Ordia
-- Define el almacenamiento con RLS de privilegio mínimo (solo SELECT para authenticated),
-- invariantes transaccionales y funciones atómicas en esquema privado para registrar
-- avisos bancarios, resolverlos como movimientos o transferencias, vincularlos
-- estrictamente a movimientos existentes o descartarlos sin sobrescritura.

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create table if not exists public.bank_card_account_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  identifier_type text not null check (identifier_type in ('card', 'account')),
  last_digits text not null check (last_digits ~ '^[0-9]{2,8}$'),
  account_id uuid not null references public.financial_accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_card_account_links_user_identifier_unique unique (user_id, identifier_type, last_digits)
);

create index if not exists bank_card_account_links_lookup_idx
on public.bank_card_account_links (user_id, identifier_type, last_digits);

create index if not exists bank_card_account_links_account_idx
on public.bank_card_account_links (account_id);

alter table public.bank_card_account_links enable row level security;
revoke all on table public.bank_card_account_links from anon, public, authenticated;
grant select on table public.bank_card_account_links to authenticated;
grant all on table public.bank_card_account_links to service_role;

create policy "Users select own card account links"
on public.bank_card_account_links for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.validate_bank_card_account_link()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  account_owner uuid;
begin
  if current_user in ('anon', 'authenticated')
    or current_setting('ordia.bank_notification_flow', true) is distinct from 'on'
  then
    raise exception 'Los enlaces de tarjetas y cuentas deben gestionarse mediante las operaciones de la bandeja' using errcode = '42501';
  end if;

  select user_id into account_owner
  from public.financial_accounts
  where id = new.account_id;

  if not found or account_owner is distinct from new.user_id then
    raise exception 'La cuenta no pertenece al usuario autenticado' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.created_at is distinct from old.created_at
    then
      raise exception 'La identidad y el propietario del enlace son inmutables' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists validate_bank_card_account_link_trigger on public.bank_card_account_links;
create trigger validate_bank_card_account_link_trigger
before insert or update on public.bank_card_account_links
for each row execute function public.validate_bank_card_account_link();

create table if not exists public.bank_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_request_id uuid not null,
  bank_name text not null default 'Bancolombia' check (length(btrim(bank_name)) between 1 and 80),
  source_channel text not null default 'manual' check (source_channel in ('manual', 'gmail')),
  notification_type text not null check (notification_type in ('transfer_received', 'purchase', 'transfer_sent')),
  amount bigint not null check (amount between 1 and 9000000000000),
  currency text not null default 'COP' check (currency = 'COP'),
  occurred_on date not null,
  occurred_time text not null check (occurred_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  merchant text,
  account_last_digits text check (account_last_digits is null or account_last_digits ~ '^[0-9]{2,8}$'),
  card_last_digits text check (card_last_digits is null or card_last_digits ~ '^[0-9]{2,8}$'),
  card_type text check (card_type is null or card_type in ('debit', 'credit')),
  counterparty_name text,
  counterparty_account_last_digits text check (counterparty_account_last_digits is null or counterparty_account_last_digits ~ '^[0-9]{2,8}$'),
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  resolved_transaction_id uuid references public.financial_transactions(id),
  resolution_request_id uuid,
  dismissed_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_notifications_user_request_unique unique (user_id, client_request_id),
  constraint bank_notifications_status_shape_check check (
    (
      status = 'pending'
      and resolved_transaction_id is null
      and resolution_request_id is null
      and resolved_at is null
      and dismissed_at is null
    )
    or (
      status = 'resolved'
      and resolved_transaction_id is not null
      and resolved_at is not null
      and dismissed_at is null
    )
    or (
      status = 'dismissed'
      and resolved_transaction_id is null
      and resolution_request_id is null
      and resolved_at is null
      and dismissed_at is not null
    )
  )
);

create index if not exists bank_notifications_user_status_idx
on public.bank_notifications (user_id, status, occurred_on desc);

create unique index if not exists bank_notifications_resolved_tx_unique
on public.bank_notifications (resolved_transaction_id)
where resolved_transaction_id is not null;

create unique index if not exists bank_notifications_resolution_request_unique
on public.bank_notifications (user_id, resolution_request_id)
where resolution_request_id is not null;

alter table public.bank_notifications enable row level security;
revoke all on table public.bank_notifications from anon, public, authenticated;
grant select on table public.bank_notifications to authenticated;
grant all on table public.bank_notifications to service_role;

create policy "Users select own bank notifications"
on public.bank_notifications for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.validate_bank_notification()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
    or current_setting('ordia.bank_notification_flow', true) is distinct from 'on'
  then
    raise exception 'Los avisos bancarios deben gestionarse mediante las operaciones de la bandeja' using errcode = '42501';
  end if;

  new.bank_name := btrim(new.bank_name);
  new.merchant := nullif(btrim(new.merchant), '');
  new.counterparty_name := nullif(btrim(new.counterparty_name), '');

  if tg_op = 'INSERT' and new.status <> 'pending' then
    raise exception 'Un aviso bancario nuevo debe crearse en estado pendiente' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if old.status in ('resolved', 'dismissed') then
      raise exception 'La resolución o el descarte de un aviso bancario no puede sobrescribirse' using errcode = '23505';
    end if;

    if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.client_request_id is distinct from old.client_request_id
      or new.bank_name is distinct from old.bank_name
      or new.source_channel is distinct from old.source_channel
      or new.notification_type is distinct from old.notification_type
      or new.amount is distinct from old.amount
      or new.currency is distinct from old.currency
      or new.occurred_on is distinct from old.occurred_on
      or new.occurred_time is distinct from old.occurred_time
      or new.merchant is distinct from old.merchant
      or new.account_last_digits is distinct from old.account_last_digits
      or new.card_last_digits is distinct from old.card_last_digits
      or new.card_type is distinct from old.card_type
      or new.counterparty_name is distinct from old.counterparty_name
      or new.counterparty_account_last_digits is distinct from old.counterparty_account_last_digits
      or new.created_at is distinct from old.created_at
    then
      raise exception 'Los datos originales del aviso bancario son inmutables' using errcode = '23514';
    end if;

    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists validate_bank_notification_trigger on public.bank_notifications;
create trigger validate_bank_notification_trigger
before insert or update on public.bank_notifications
for each row execute function public.validate_bank_notification();

-- 1. Crear un aviso bancario pendiente (idempotente por client_request_id)
create or replace function private.create_bank_notification(
  p_request_id uuid,
  p_bank_name text,
  p_source_channel text,
  p_notification_type text,
  p_amount bigint,
  p_occurred_on date,
  p_occurred_time text,
  p_merchant text,
  p_account_last_digits text,
  p_card_last_digits text,
  p_card_type text,
  p_counterparty_name text,
  p_counterparty_account_last_digits text
)
returns public.bank_notifications
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  result public.bank_notifications;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'Request id is required' using errcode = '22023';
  end if;

  perform set_config('ordia.bank_notification_flow', 'on', true);

  insert into public.bank_notifications (
    user_id, client_request_id, bank_name, source_channel, notification_type,
    amount, currency, occurred_on, occurred_time, merchant, account_last_digits,
    card_last_digits, card_type, counterparty_name, counterparty_account_last_digits,
    status
  ) values (
    current_user_id, p_request_id, coalesce(nullif(btrim(p_bank_name), ''), 'Bancolombia'),
    coalesce(p_source_channel, 'manual'), p_notification_type, p_amount, 'COP',
    p_occurred_on, p_occurred_time, p_merchant, p_account_last_digits,
    p_card_last_digits, p_card_type, p_counterparty_name,
    p_counterparty_account_last_digits, 'pending'
  )
  on conflict (user_id, client_request_id) do nothing
  returning * into result;

  perform set_config('ordia.bank_notification_flow', 'off', true);

  if result.id is null then
    select * into result from public.bank_notifications
    where user_id = current_user_id and client_request_id = p_request_id;
  end if;

  return result;
end;
$$;

-- 2. Confirmar y resolver aviso bancario como gasto o ingreso (atómico)
create or replace function private.confirm_bank_notification_as_transaction(
  p_notification_id uuid,
  p_request_id uuid,
  p_kind text,
  p_account_id uuid,
  p_category_id uuid,
  p_description text,
  p_occurred_on date,
  p_remember_link boolean default false,
  p_identifier_type text default null,
  p_last_digits text default null
)
returns public.financial_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  notification_record public.bank_notifications;
  result public.financial_transactions;
  category_record public.financial_categories;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'Request id is required' using errcode = '22023';
  end if;

  -- Bloqueo transaccional de la fila del aviso
  select * into notification_record
  from public.bank_notifications
  where id = p_notification_id and user_id = current_user_id
  for update;

  if not found then
    raise exception 'El aviso bancario no existe' using errcode = '23503';
  end if;

  if notification_record.status = 'resolved' then
    if notification_record.resolution_request_id = p_request_id then
      select * into result from public.financial_transactions
      where id = notification_record.resolved_transaction_id and user_id = current_user_id;
      return result;
    end if;
    raise exception 'Este aviso bancario ya fue registrado previamente' using errcode = '23505';
  end if;

  if notification_record.status = 'dismissed' then
    raise exception 'Este aviso bancario fue descartado' using errcode = '23514';
  end if;

  -- Validar sentido compatible con el tipo de aviso
  if notification_record.notification_type = 'transfer_received' and p_kind <> 'income' then
    raise exception 'Una transferencia recibida solo puede registrarse como ingreso o transferencia propia' using errcode = '23514';
  end if;

  if notification_record.notification_type in ('purchase', 'transfer_sent') and p_kind <> 'expense' then
    raise exception 'Un aviso de salida o compra solo puede registrarse como gasto' using errcode = '23514';
  end if;

  -- Validar que la cuenta pertenezca al usuario y esté activa
  if not exists (
    select 1
    from public.financial_accounts
    where id = p_account_id and user_id = current_user_id and archived_at is null
  ) then
    raise exception 'La cuenta no existe o está archivada' using errcode = '23503';
  end if;

  -- Validar categoría activa y del mismo tipo (ingreso o gasto)
  select * into category_record
  from public.financial_categories
  where id = p_category_id and user_id = current_user_id and archived_at is null;

  if not found then
    raise exception 'La categoría no existe o está archivada' using errcode = '23503';
  end if;

  if category_record.kind <> p_kind then
    raise exception 'La categoría seleccionada no corresponde al tipo de movimiento' using errcode = '23514';
  end if;

  -- Insertar el movimiento financiero (sin silenciar conflictos: cualquier fallo revierte toda la transacción)
  insert into public.financial_transactions (
    user_id, client_request_id, kind, account_id, destination_account_id,
    amount, occurred_on, category_id, description
  ) values (
    current_user_id, p_request_id, p_kind, p_account_id, null,
    notification_record.amount, coalesce(p_occurred_on, notification_record.occurred_on),
    p_category_id, nullif(btrim(p_description), '')
  )
  returning * into result;

  perform set_config('ordia.bank_notification_flow', 'on', true);

  -- Actualizar el estado del aviso a resuelto
  update public.bank_notifications
  set status = 'resolved',
      resolved_transaction_id = result.id,
      resolution_request_id = p_request_id,
      resolved_at = now()
  where id = p_notification_id and user_id = current_user_id;

  perform set_config('ordia.bank_notification_flow', 'off', true);

  -- Si se solicitó recordar la asociación de tarjeta o cuenta
  if p_remember_link and p_identifier_type is not null and p_last_digits is not null then
    perform set_config('ordia.bank_notification_flow', 'on', true);
    insert into public.bank_card_account_links (
      user_id, identifier_type, last_digits, account_id
    ) values (
      current_user_id, p_identifier_type, p_last_digits, p_account_id
    )
    on conflict (user_id, identifier_type, last_digits)
    do update set account_id = excluded.account_id, updated_at = now();
    perform set_config('ordia.bank_notification_flow', 'off', true);
  end if;

  return result;
end;
$$;

-- 3. Confirmar y resolver aviso bancario como transferencia entre cuentas propias (atómico)
create or replace function private.confirm_bank_notification_as_transfer(
  p_notification_id uuid,
  p_request_id uuid,
  p_account_id uuid,
  p_destination_account_id uuid,
  p_description text,
  p_occurred_on date,
  p_remember_link boolean default false,
  p_identifier_type text default null,
  p_last_digits text default null
)
returns public.financial_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  notification_record public.bank_notifications;
  result public.financial_transactions;
  linked_account_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if p_request_id is null then
    raise exception 'Request id is required' using errcode = '22023';
  end if;

  if p_account_id = p_destination_account_id then
    raise exception 'La cuenta de origen y destino no pueden ser iguales' using errcode = '23514';
  end if;

  -- Bloqueo transaccional del aviso
  select * into notification_record
  from public.bank_notifications
  where id = p_notification_id and user_id = current_user_id
  for update;

  if not found then
    raise exception 'El aviso bancario no existe' using errcode = '23503';
  end if;

  if notification_record.status = 'resolved' then
    if notification_record.resolution_request_id = p_request_id then
      select * into result from public.financial_transactions
      where id = notification_record.resolved_transaction_id and user_id = current_user_id;
      return result;
    end if;
    raise exception 'Este aviso bancario ya fue registrado previamente' using errcode = '23505';
  end if;

  if notification_record.status = 'dismissed' then
    raise exception 'Este aviso bancario fue descartado' using errcode = '23514';
  end if;

  if notification_record.notification_type = 'purchase' then
    raise exception 'Una compra con tarjeta no puede registrarse como transferencia entre cuentas propias' using errcode = '23514';
  end if;

  -- Validar ambas cuentas activas del usuario
  if not exists (
    select 1
    from public.financial_accounts
    where id = p_account_id and user_id = current_user_id and archived_at is null
  ) then
    raise exception 'La cuenta de origen no existe o está archivada' using errcode = '23503';
  end if;

  if not exists (
    select 1
    from public.financial_accounts
    where id = p_destination_account_id and user_id = current_user_id and archived_at is null
  ) then
    raise exception 'La cuenta de destino no existe o está archivada' using errcode = '23503';
  end if;

  -- Crear una sola fila de transferencia (cualquier fallo revierte la transacción completa)
  insert into public.financial_transactions (
    user_id, client_request_id, kind, account_id, destination_account_id,
    amount, occurred_on, category_id, description
  ) values (
    current_user_id, p_request_id, 'transfer', p_account_id, p_destination_account_id,
    notification_record.amount, coalesce(p_occurred_on, notification_record.occurred_on),
    null, nullif(btrim(p_description), '')
  )
  returning * into result;

  perform set_config('ordia.bank_notification_flow', 'on', true);

  -- Actualizar el estado del aviso a resuelto
  update public.bank_notifications
  set status = 'resolved',
      resolved_transaction_id = result.id,
      resolution_request_id = p_request_id,
      resolved_at = now()
  where id = p_notification_id and user_id = current_user_id;

  perform set_config('ordia.bank_notification_flow', 'off', true);

  -- Recordar asociación: en entrada la cuenta del aviso es destino; en salida es origen
  if p_remember_link and p_identifier_type is not null and p_last_digits is not null then
    linked_account_id := case
      when notification_record.notification_type = 'transfer_received' then p_destination_account_id
      else p_account_id
    end;

    perform set_config('ordia.bank_notification_flow', 'on', true);
    insert into public.bank_card_account_links (
      user_id, identifier_type, last_digits, account_id
    ) values (
      current_user_id, p_identifier_type, p_last_digits, linked_account_id
    )
    on conflict (user_id, identifier_type, last_digits)
    do update set account_id = excluded.account_id, updated_at = now();
    perform set_config('ordia.bank_notification_flow', 'off', true);
  end if;

  return result;
end;
$$;

-- 4. Vincular aviso a un movimiento existente («Ya lo registré») con validación completa
create or replace function private.link_bank_notification_to_transaction(
  p_notification_id uuid,
  p_transaction_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  notification_record public.bank_notifications;
  tx_record public.financial_transactions;
  known_account_id uuid := null;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select * into notification_record
  from public.bank_notifications
  where id = p_notification_id and user_id = current_user_id
  for update;

  if not found then
    raise exception 'El aviso bancario no existe' using errcode = '23503';
  end if;

  if notification_record.status = 'resolved' then
    raise exception 'Este aviso ya fue resuelto previamente' using errcode = '23505';
  end if;

  if notification_record.status = 'dismissed' then
    raise exception 'Este aviso fue descartado' using errcode = '23514';
  end if;

  -- 1. Validar propietario y movimiento vigente (no eliminado lógicamente)
  select * into tx_record
  from public.financial_transactions
  where id = p_transaction_id and user_id = current_user_id and deleted_at is null
  for update;

  if not found then
    raise exception 'El movimiento no existe o fue eliminado' using errcode = '23503';
  end if;

  if exists (
    select 1 from public.bank_notifications
    where resolved_transaction_id = p_transaction_id
  ) then
    raise exception 'Este movimiento ya está vinculado a otro aviso bancario' using errcode = '23505';
  end if;

  -- 2. Validar importe exacto en COP enteros
  if tx_record.amount <> notification_record.amount then
    raise exception 'El importe del movimiento no coincide exactamente con el aviso bancario' using errcode = '23514';
  end if;

  -- 3. Resolver cuenta conocida si el usuario asoció los últimos dígitos de la tarjeta o cuenta
  if notification_record.card_last_digits is not null then
    select l.account_id into known_account_id
    from public.bank_card_account_links l
    join public.financial_accounts a on a.id = l.account_id and a.user_id = current_user_id
    where l.user_id = current_user_id
      and l.identifier_type = 'card'
      and l.last_digits = notification_record.card_last_digits;
  end if;

  if known_account_id is null and notification_record.account_last_digits is not null then
    select l.account_id into known_account_id
    from public.bank_card_account_links l
    join public.financial_accounts a on a.id = l.account_id and a.user_id = current_user_id
    where l.user_id = current_user_id
      and l.identifier_type = 'account'
      and l.last_digits = notification_record.account_last_digits;
  end if;

  -- 4. Validar tipo, sentido y cuenta (origen en salidas, destino en entradas para transferencias propias)
  if notification_record.notification_type = 'purchase' then
    if tx_record.kind <> 'expense' then
      raise exception 'Una compra solo puede vincularse a un gasto registrado' using errcode = '23514';
    end if;
    if known_account_id is not null and tx_record.account_id <> known_account_id then
      raise exception 'La cuenta del gasto no coincide con la cuenta asociada a la tarjeta o cuenta del aviso' using errcode = '23514';
    end if;
  elsif notification_record.notification_type = 'transfer_sent' then
    if tx_record.kind not in ('expense', 'transfer') then
      raise exception 'Una transferencia enviada solo puede vincularse a un gasto o a una transferencia entre cuentas propias' using errcode = '23514';
    end if;
    if known_account_id is not null and tx_record.account_id <> known_account_id then
      raise exception 'La cuenta de origen del movimiento no coincide con la cuenta asociada al aviso de salida' using errcode = '23514';
    end if;
  else
    -- transfer_received
    if tx_record.kind not in ('income', 'transfer') then
      raise exception 'Una transferencia recibida solo puede vincularse a un ingreso o a una transferencia entre cuentas propias' using errcode = '23514';
    end if;
    if known_account_id is not null then
      if tx_record.kind = 'income' and tx_record.account_id <> known_account_id then
        raise exception 'La cuenta del ingreso no coincide con la cuenta asociada al aviso de entrada' using errcode = '23514';
      end if;
      if tx_record.kind = 'transfer' and tx_record.destination_account_id is distinct from known_account_id then
        raise exception 'La cuenta de destino de la transferencia no coincide con la cuenta asociada al aviso de entrada' using errcode = '23514';
      end if;
    end if;
  end if;

  perform set_config('ordia.bank_notification_flow', 'on', true);

  update public.bank_notifications
  set status = 'resolved',
      resolved_transaction_id = p_transaction_id,
      resolved_at = now()
  where id = p_notification_id and user_id = current_user_id;

  perform set_config('ordia.bank_notification_flow', 'off', true);
end;
$$;

-- 5. Descartar aviso bancario
create or replace function private.dismiss_bank_notification(
  p_notification_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  notification_record public.bank_notifications;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select * into notification_record
  from public.bank_notifications
  where id = p_notification_id and user_id = current_user_id
  for update;

  if not found then
    raise exception 'El aviso bancario no existe' using errcode = '23503';
  end if;

  if notification_record.status = 'resolved' then
    raise exception 'No se puede descartar un aviso que ya fue registrado' using errcode = '23505';
  end if;

  if notification_record.status = 'dismissed' then
    return;
  end if;

  perform set_config('ordia.bank_notification_flow', 'on', true);

  update public.bank_notifications
  set status = 'dismissed',
      dismissed_at = now()
  where id = p_notification_id and user_id = current_user_id;

  perform set_config('ordia.bank_notification_flow', 'off', true);
end;
$$;

-- 6. Guardar o actualizar asociación personal de tarjeta o cuenta
create or replace function private.upsert_card_account_link(
  p_identifier_type text,
  p_last_digits text,
  p_account_id uuid
)
returns public.bank_card_account_links
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  result public.bank_card_account_links;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.financial_accounts
    where id = p_account_id and user_id = current_user_id and archived_at is null
  ) then
    raise exception 'La cuenta no pertenece al usuario autenticado o está archivada' using errcode = '23503';
  end if;

  perform set_config('ordia.bank_notification_flow', 'on', true);

  insert into public.bank_card_account_links (
    user_id, identifier_type, last_digits, account_id
  ) values (
    current_user_id, p_identifier_type, p_last_digits, p_account_id
  )
  on conflict (user_id, identifier_type, last_digits)
  do update set account_id = excluded.account_id, updated_at = now()
  returning * into result;

  perform set_config('ordia.bank_notification_flow', 'off', true);

  return result;
end;
$$;

-- Envoltorios públicos SECURITY INVOKER (exposición segura en PostgREST)
create or replace function public.create_bank_notification(
  p_request_id uuid,
  p_bank_name text,
  p_source_channel text,
  p_notification_type text,
  p_amount bigint,
  p_occurred_on date,
  p_occurred_time text,
  p_merchant text,
  p_account_last_digits text,
  p_card_last_digits text,
  p_card_type text,
  p_counterparty_name text,
  p_counterparty_account_last_digits text
)
returns public.bank_notifications
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.create_bank_notification(
    p_request_id,
    p_bank_name,
    p_source_channel,
    p_notification_type,
    p_amount,
    p_occurred_on,
    p_occurred_time,
    p_merchant,
    p_account_last_digits,
    p_card_last_digits,
    p_card_type,
    p_counterparty_name,
    p_counterparty_account_last_digits
  );
$$;

create or replace function public.confirm_bank_notification_as_transaction(
  p_notification_id uuid,
  p_request_id uuid,
  p_kind text,
  p_account_id uuid,
  p_category_id uuid,
  p_description text,
  p_occurred_on date,
  p_remember_link boolean default false,
  p_identifier_type text default null,
  p_last_digits text default null
)
returns public.financial_transactions
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.confirm_bank_notification_as_transaction(
    p_notification_id,
    p_request_id,
    p_kind,
    p_account_id,
    p_category_id,
    p_description,
    p_occurred_on,
    p_remember_link,
    p_identifier_type,
    p_last_digits
  );
$$;

create or replace function public.confirm_bank_notification_as_transfer(
  p_notification_id uuid,
  p_request_id uuid,
  p_account_id uuid,
  p_destination_account_id uuid,
  p_description text,
  p_occurred_on date,
  p_remember_link boolean default false,
  p_identifier_type text default null,
  p_last_digits text default null
)
returns public.financial_transactions
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.confirm_bank_notification_as_transfer(
    p_notification_id,
    p_request_id,
    p_account_id,
    p_destination_account_id,
    p_description,
    p_occurred_on,
    p_remember_link,
    p_identifier_type,
    p_last_digits
  );
$$;

create or replace function public.link_bank_notification_to_transaction(
  p_notification_id uuid,
  p_transaction_id uuid
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.link_bank_notification_to_transaction(
    p_notification_id,
    p_transaction_id
  );
$$;

create or replace function public.dismiss_bank_notification(
  p_notification_id uuid
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.dismiss_bank_notification(p_notification_id);
$$;

create or replace function public.upsert_card_account_link(
  p_identifier_type text,
  p_last_digits text,
  p_account_id uuid
)
returns public.bank_card_account_links
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.upsert_card_account_link(
    p_identifier_type,
    p_last_digits,
    p_account_id
  );
$$;

revoke all on function public.validate_bank_card_account_link() from public, anon, authenticated;
revoke all on function public.validate_bank_notification() from public, anon, authenticated;

revoke all on function private.create_bank_notification(uuid, text, text, text, bigint, date, text, text, text, text, text, text, text) from public, anon;
revoke all on function private.confirm_bank_notification_as_transaction(uuid, uuid, text, uuid, uuid, text, date, boolean, text, text) from public, anon;
revoke all on function private.confirm_bank_notification_as_transfer(uuid, uuid, uuid, uuid, text, date, boolean, text, text) from public, anon;
revoke all on function private.link_bank_notification_to_transaction(uuid, uuid) from public, anon;
revoke all on function private.dismiss_bank_notification(uuid) from public, anon;
revoke all on function private.upsert_card_account_link(text, text, uuid) from public, anon;

grant execute on function private.create_bank_notification(uuid, text, text, text, bigint, date, text, text, text, text, text, text, text) to authenticated;
grant execute on function private.confirm_bank_notification_as_transaction(uuid, uuid, text, uuid, uuid, text, date, boolean, text, text) to authenticated;
grant execute on function private.confirm_bank_notification_as_transfer(uuid, uuid, uuid, uuid, text, date, boolean, text, text) to authenticated;
grant execute on function private.link_bank_notification_to_transaction(uuid, uuid) to authenticated;
grant execute on function private.dismiss_bank_notification(uuid) to authenticated;
grant execute on function private.upsert_card_account_link(text, text, uuid) to authenticated;

revoke all on function public.create_bank_notification(uuid, text, text, text, bigint, date, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.confirm_bank_notification_as_transaction(uuid, uuid, text, uuid, uuid, text, date, boolean, text, text) from public, anon;
revoke all on function public.confirm_bank_notification_as_transfer(uuid, uuid, uuid, uuid, text, date, boolean, text, text) from public, anon;
revoke all on function public.link_bank_notification_to_transaction(uuid, uuid) from public, anon;
revoke all on function public.dismiss_bank_notification(uuid) from public, anon;
revoke all on function public.upsert_card_account_link(text, text, uuid) from public, anon;

grant execute on function public.create_bank_notification(uuid, text, text, text, bigint, date, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.confirm_bank_notification_as_transaction(uuid, uuid, text, uuid, uuid, text, date, boolean, text, text) to authenticated;
grant execute on function public.confirm_bank_notification_as_transfer(uuid, uuid, uuid, uuid, text, date, boolean, text, text) to authenticated;
grant execute on function public.link_bank_notification_to_transaction(uuid, uuid) to authenticated;
grant execute on function public.dismiss_bank_notification(uuid) to authenticated;
grant execute on function public.upsert_card_account_link(text, text, uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'bank_notifications'
    ) then
      alter publication supabase_realtime add table public.bank_notifications;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'bank_card_account_links'
    ) then
      alter publication supabase_realtime add table public.bank_card_account_links;
    end if;
  end if;
end;
$$;
