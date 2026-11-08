-- QR conserva la hora del aviso; PSE conserva la fecha y el CUS, sin inventar hora.
alter table public.bank_notifications alter column occurred_time drop not null;
alter table public.bank_notifications add column provider_reference text
  check (provider_reference is null or provider_reference ~ '^[0-9]{1,40}$');
alter table public.bank_notifications add constraint bank_notification_source_shape check (
  (bank_name <> 'Bancolombia' or occurred_time is not null)
  and (bank_name <> 'PSE/ACH Colombia' or occurred_time is null)
);
create unique index bank_notifications_pse_cus_unique
  on public.bank_notifications (user_id, bank_name, provider_reference)
  where provider_reference is not null;

-- La RPC heredada no puede dejar un PSE sin CUS al terminar la transacción.
-- Es diferido porque las nuevas RPC agregan el CUS tras la inserción atómica.
create function public.validate_pse_reference_complete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.bank_notifications
    where id = new.id and bank_name = 'PSE/ACH Colombia' and provider_reference is null
  ) then
    raise exception 'El comprobante PSE requiere un CUS válido' using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger validate_pse_reference_complete_trigger
  after insert or update on public.bank_notifications
  deferrable initially deferred
  for each row execute function public.validate_pse_reference_complete();
revoke all on function public.validate_pse_reference_complete() from public, anon, authenticated;

-- Varios comprobantes distintos pueden referirse al mismo gasto solo tras revisión explícita.
drop index public.bank_notifications_resolved_tx_unique;
create index bank_notifications_resolved_tx_idx
  on public.bank_notifications (resolved_transaction_id)
  where resolved_transaction_id is not null;

create function private.create_movement_notice(
  p_request_id uuid, p_bank_name text, p_source_channel text,
  p_notification_type text, p_amount bigint, p_occurred_on date,
  p_occurred_time text, p_merchant text, p_account_last_digits text,
  p_card_last_digits text, p_card_type text, p_counterparty_name text,
  p_counterparty_account_last_digits text, p_provider_reference text
)
returns public.bank_notifications
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := (select auth.uid());
  result public.bank_notifications;
begin
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
  return result;
end;
$$;

create function public.create_movement_notice(
  p_request_id uuid, p_bank_name text, p_source_channel text,
  p_notification_type text, p_amount bigint, p_occurred_on date,
  p_occurred_time text, p_merchant text, p_account_last_digits text,
  p_card_last_digits text, p_card_type text, p_counterparty_name text,
  p_counterparty_account_last_digits text, p_provider_reference text
)
returns public.bank_notifications
language sql volatile security invoker set search_path = '' as $$
  select private.create_movement_notice(
    p_request_id, p_bank_name, p_source_channel, p_notification_type,
    p_amount, p_occurred_on, p_occurred_time, p_merchant,
    p_account_last_digits, p_card_last_digits, p_card_type,
    p_counterparty_name, p_counterparty_account_last_digits, p_provider_reference
  );
$$;

create function private.ingest_movement_notice(
  p_provider_event_hash text, p_alias_local_part text, p_message_id_hash text,
  p_bank_name text, p_notification_type text, p_amount bigint,
  p_occurred_on date, p_occurred_time text, p_merchant text,
  p_account_last_digits text, p_card_last_digits text, p_card_type text,
  p_counterparty_name text, p_counterparty_account_last_digits text,
  p_provider_reference text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  alias_record public.bank_email_aliases;
  existing_id uuid;
  result jsonb;
begin
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
  return result;
end;
$$;

create function public.ingest_movement_notice(
  p_provider_event_hash text, p_alias_local_part text, p_message_id_hash text,
  p_bank_name text, p_notification_type text, p_amount bigint,
  p_occurred_on date, p_occurred_time text, p_merchant text,
  p_account_last_digits text, p_card_last_digits text, p_card_type text,
  p_counterparty_name text, p_counterparty_account_last_digits text,
  p_provider_reference text
)
returns jsonb
language sql volatile security invoker set search_path = '' as $$
  select private.ingest_movement_notice(
    p_provider_event_hash, p_alias_local_part, p_message_id_hash,
    p_bank_name, p_notification_type, p_amount, p_occurred_on,
    p_occurred_time, p_merchant, p_account_last_digits, p_card_last_digits,
    p_card_type, p_counterparty_name, p_counterparty_account_last_digits,
    p_provider_reference
  );
$$;

revoke all on function private.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text) from public, anon;
grant execute on function private.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text) to authenticated;
revoke all on function public.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text) from public, anon;
grant execute on function public.create_movement_notice(uuid,text,text,text,bigint,date,text,text,text,text,text,text,text,text) to authenticated;
revoke all on function private.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function private.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text) to service_role;
revoke all on function public.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.ingest_movement_notice(text,text,text,text,text,bigint,date,text,text,text,text,text,text,text,text) to service_role;

-- Permitir la vinculación manual de ambos comprobantes al mismo movimiento.
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
