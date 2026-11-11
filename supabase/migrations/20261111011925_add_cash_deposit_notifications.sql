-- Consignaciones recibidas por corresponsal: ingreso externo, sin cuenta propia de origen.
alter table public.bank_notifications drop constraint bank_notifications_notification_type_check;
alter table public.bank_notifications add constraint bank_notifications_notification_type_check
  check (notification_type in ('transfer_received','purchase','transfer_sent','cash_deposit_received'));
alter table public.bank_notifications add column correspondent_name text
  check (correspondent_name is null or length(btrim(correspondent_name)) between 1 and 240);
alter table public.bank_notifications add column municipality text
  check (municipality is null or length(btrim(municipality)) between 1 and 160);
alter table public.bank_notifications add constraint cash_deposit_identifiers_check check (
  notification_type <> 'cash_deposit_received' or (
    bank_name = 'Bancolombia' and occurred_time is not null
    and account_last_digits is null and card_last_digits is null and card_type is null
    and counterparty_name is null and counterparty_account_last_digits is null
    and merchant is null and provider_reference is null
  )
);

drop function public.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text);
drop function private.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text);
drop function public.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text);
drop function private.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text);

create function private.create_movement_notice(
  p_request_id uuid, p_bank_name text, p_source_channel text,
  p_notification_type text, p_amount bigint, p_occurred_on date,
  p_occurred_time text, p_merchant text, p_account_last_digits text,
  p_card_last_digits text, p_card_type text, p_counterparty_name text,
  p_counterparty_account_last_digits text, p_provider_reference text,
  p_correspondent_name text default null, p_municipality text default null
)
returns public.bank_notifications
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := (select auth.uid());
  result public.bank_notifications;
begin
  if p_notification_type = 'cash_deposit_received' and (
    nullif(btrim(p_correspondent_name),'') is null or nullif(btrim(p_municipality),'') is null
  ) then
    raise exception 'La consignación requiere corresponsal y municipio' using errcode = '23514';
  end if;
  if owner_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_bank_name = 'PSE/ACH Colombia' and (p_provider_reference is null or p_provider_reference !~ '^[0-9]{1,40}$') then
    raise exception 'El comprobante PSE requiere un CUS válido' using errcode = '23514';
  end if;
  if p_provider_reference is not null then
    if p_bank_name <> 'PSE/ACH Colombia' then
      raise exception 'El CUS solo corresponde a PSE' using errcode = '23514';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_id::text || ':pse:' || p_provider_reference, 0));
    select * into result from public.bank_notifications
      where user_id = owner_id and bank_name = p_bank_name and provider_reference = p_provider_reference;
    if found then return result; end if;
  end if;
  result := private.create_bank_notification(
    p_request_id, p_bank_name, p_source_channel, p_notification_type,
    p_amount, p_occurred_on, p_occurred_time, p_merchant,
    p_account_last_digits, p_card_last_digits, p_card_type,
    p_counterparty_name, p_counterparty_account_last_digits
  );
  if p_provider_reference is not null and result.provider_reference is null then
    perform pg_catalog.set_config('ordia.bank_notification_flow', 'on', true);
    update public.bank_notifications set provider_reference = p_provider_reference
      where id = result.id returning * into result;
    perform pg_catalog.set_config('ordia.bank_notification_flow', 'off', true);
  end if;
  if p_notification_type = 'cash_deposit_received' and result.correspondent_name is null then
    perform set_config('ordia.bank_notification_flow','on',true);
    update public.bank_notifications set correspondent_name = btrim(p_correspondent_name), municipality = btrim(p_municipality)
      where id = result.id returning * into result;
    perform set_config('ordia.bank_notification_flow','off',true);
  end if;
  return result;
end;
$$;

create function public.create_movement_notice(
  p_request_id uuid, p_bank_name text, p_source_channel text,
  p_notification_type text, p_amount bigint, p_occurred_on date,
  p_occurred_time text, p_merchant text, p_account_last_digits text,
  p_card_last_digits text, p_card_type text, p_counterparty_name text,
  p_counterparty_account_last_digits text, p_provider_reference text,
  p_correspondent_name text default null, p_municipality text default null
)
returns public.bank_notifications
language sql volatile security invoker set search_path = '' as $$
  select private.create_movement_notice(
    p_request_id, p_bank_name, p_source_channel, p_notification_type,
    p_amount, p_occurred_on, p_occurred_time, p_merchant,
    p_account_last_digits, p_card_last_digits, p_card_type,
    p_counterparty_name, p_counterparty_account_last_digits, p_provider_reference, p_correspondent_name, p_municipality
  );
$$;

create function private.ingest_movement_notice(
  p_provider_event_hash text, p_alias_local_part text, p_message_id_hash text,
  p_bank_name text, p_notification_type text, p_amount bigint,
  p_occurred_on date, p_occurred_time text, p_merchant text,
  p_account_last_digits text, p_card_last_digits text, p_card_type text,
  p_counterparty_name text, p_counterparty_account_last_digits text,
  p_provider_reference text,
  p_correspondent_name text default null, p_municipality text default null
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  alias_record public.bank_email_aliases;
  existing_id uuid;
  result jsonb;
begin
  if p_notification_type = 'cash_deposit_received' and (
    nullif(btrim(p_correspondent_name),'') is null or nullif(btrim(p_municipality),'') is null
  ) then
    raise exception 'La consignación requiere corresponsal y municipio' using errcode = '23514';
  end if;
  if p_bank_name = 'PSE/ACH Colombia' and (p_provider_reference is null or p_provider_reference !~ '^[0-9]{1,40}$') then
    raise exception 'El comprobante PSE requiere un CUS válido' using errcode = '23514';
  end if;
  if p_provider_reference is not null then
    if p_bank_name <> 'PSE/ACH Colombia' then
      raise exception 'El CUS solo corresponde a PSE' using errcode = '23514';
    end if;
    select * into alias_record from public.bank_email_aliases
      where alias_local_part = lower(btrim(p_alias_local_part)) for update;
    if not found then
      return jsonb_build_object('outcome','alias_not_found','is_new_notification',false);
    end if;
    if not alias_record.is_current or alias_record.status = 'disabled' then
      return jsonb_build_object('outcome','alias_inactive','is_new_notification',false);
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(alias_record.user_id::text || ':pse:' || p_provider_reference, 0));
    select id into existing_id from public.bank_notifications
      where user_id = alias_record.user_id and bank_name = p_bank_name and provider_reference = p_provider_reference;
    if found then
      return jsonb_build_object('outcome','duplicate','is_new_notification',false,
        'user_id',alias_record.user_id,'notification_id',existing_id);
    end if;
  end if;
  result := private.ingest_bank_inbound_notification(
    p_provider_event_hash, p_alias_local_part, p_message_id_hash,
    p_bank_name, p_notification_type, p_amount, p_occurred_on,
    p_occurred_time, p_merchant, p_account_last_digits, p_card_last_digits,
    p_card_type, p_counterparty_name, p_counterparty_account_last_digits
  );
  if p_provider_reference is not null and result->>'outcome' = 'created' then
    perform pg_catalog.set_config('ordia.bank_notification_flow', 'on', true);
    update public.bank_notifications set provider_reference = p_provider_reference
      where id = (result->>'notification_id')::uuid;
    perform pg_catalog.set_config('ordia.bank_notification_flow', 'off', true);
  end if;
  if p_notification_type = 'cash_deposit_received' and result->>'outcome' = 'created' then
    perform set_config('ordia.bank_notification_flow','on',true);
    update public.bank_notifications set correspondent_name = btrim(p_correspondent_name), municipality = btrim(p_municipality)
      where id = (result->>'notification_id')::uuid;
    perform set_config('ordia.bank_notification_flow','off',true);
  end if;
  return result;
end;
$$;

create function public.ingest_movement_notice(
  p_provider_event_hash text, p_alias_local_part text, p_message_id_hash text,
  p_bank_name text, p_notification_type text, p_amount bigint,
  p_occurred_on date, p_occurred_time text, p_merchant text,
  p_account_last_digits text, p_card_last_digits text, p_card_type text,
  p_counterparty_name text, p_counterparty_account_last_digits text,
  p_provider_reference text,
  p_correspondent_name text default null, p_municipality text default null
)
returns jsonb
language sql volatile security invoker set search_path = '' as $$
  select private.ingest_movement_notice(
    p_provider_event_hash, p_alias_local_part, p_message_id_hash,
    p_bank_name, p_notification_type, p_amount, p_occurred_on,
    p_occurred_time, p_merchant, p_account_last_digits, p_card_last_digits,
    p_card_type, p_counterparty_name, p_counterparty_account_last_digits,
    p_provider_reference, p_correspondent_name, p_municipality
  );
$$;

revoke all on function private.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text,text,text) from public, anon;
grant execute on function private.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text,text,text) to authenticated;
revoke all on function public.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text,text,text) to authenticated;
revoke all on function private.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function private.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text,text,text) to service_role;
revoke all on function public.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text,text,text) to service_role;

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
  if notification_record.notification_type in ('transfer_received','cash_deposit_received') and p_kind <> 'income' then
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

  if notification_record.notification_type = 'cash_deposit_received' and not exists (
    select 1 from public.financial_accounts where id = p_account_id and user_id = current_user_id
      and account_type = 'bank' and archived_at is null
  ) then
    raise exception 'Selecciona una cuenta bancaria receptora activa' using errcode = '23514';
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

  if notification_record.notification_type in ('purchase','cash_deposit_received') then
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
  if notification_record.notification_type = 'cash_deposit_received' then
    if tx_record.kind <> 'income' or not exists (
      select 1 from public.financial_accounts where id = tx_record.account_id
        and user_id = current_user_id and account_type = 'bank'
    ) then
      raise exception 'Una consignación solo puede vincularse a un ingreso en una cuenta bancaria' using errcode = '23514';
    end if;
  elsif notification_record.notification_type = 'purchase' then
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
