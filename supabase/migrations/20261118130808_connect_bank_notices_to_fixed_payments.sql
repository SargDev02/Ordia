-- Pago y aviso se resuelven en la misma transacción, reutilizando validaciones vigentes.
create function public.pay_fixed_expense_from_bank_notice(
  p_notification_id uuid, p_period_id uuid, p_request_id uuid,
  p_account_id uuid, p_category_id uuid, p_paid_on date, p_amount bigint
) returns public.financial_transactions
language plpgsql security invoker set search_path = '' as $$
declare
  owner_id uuid := (select auth.uid());
  period_record public.fixed_expense_periods;
  notice public.bank_notifications;
  result public.financial_transactions;
begin
  if owner_id is null then raise exception 'Authentication is required' using errcode='42501'; end if;
  select * into period_record from public.fixed_expense_periods
    where id=p_period_id and user_id=owner_id for update;
  if not found then raise exception 'La obligación no existe' using errcode='23503'; end if;
  select * into notice from public.bank_notifications where id=p_notification_id and user_id=owner_id;
  if not found then raise exception 'El aviso no existe' using errcode='23503'; end if;
  if notice.notification_type not in ('purchase','transfer_sent') then
    raise exception 'Solo los avisos de salida pueden pagar un gasto fijo' using errcode='23514';
  end if;
  if p_amount is distinct from notice.amount then
    raise exception 'El importe real debe coincidir exactamente con el aviso; no se admiten pagos parciales' using errcode='23514';
  end if;
  -- Reintento confirmado: devuelve el mismo movimiento; otra solicitud no crea otro pago.
  if notice.status='resolved' and notice.resolved_transaction_id=period_record.transaction_id
    and period_record.payment_request_id=p_request_id then
    select * into result from public.financial_transactions
      where id=period_record.transaction_id and user_id=owner_id and deleted_at is null;
    if found then return result; end if;
  end if;
  if notice.status <> 'pending' then raise exception 'El aviso ya fue resuelto o descartado' using errcode='23505'; end if;
  -- La RPC existente bloquea período/cuentas y valida categoría e importe positivos.
  result := public.pay_fixed_expense_period(p_period_id,p_request_id,p_account_id,p_category_id,p_paid_on,p_amount);
  -- El vínculo bloquea aviso/movimiento y comprueba sentido, cuenta conocida e importe.
  -- Si falla, PostgreSQL revierte también el pago de la obligación.
  perform public.link_bank_notification_to_transaction(p_notification_id,result.id);
  return result;
end;
$$;
revoke all on function public.pay_fixed_expense_from_bank_notice(uuid,uuid,uuid,uuid,uuid,date,bigint) from public,anon;
grant execute on function public.pay_fixed_expense_from_bank_notice(uuid,uuid,uuid,uuid,uuid,date,bigint) to authenticated;

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
    if old.status in ('resolved', 'dismissed') and not (
      old.status = 'resolved' and new.status = 'pending'
      and new.resolved_transaction_id is null and new.resolution_request_id is null
      and new.resolved_at is null and new.dismissed_at is null
      and current_setting('ordia.bank_payment_undo', true) is not distinct from 'on'
    ) then
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


-- Helper privado para reabrir TODOS los comprobantes elegidos por el usuario al deshacer.
create function private.undo_fixed_expense_payment_with_notices(p_period_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := (select auth.uid());
  period_record public.fixed_expense_periods;
begin
  if owner_id is null then raise exception 'Authentication is required' using errcode='42501'; end if;
  select * into period_record from public.fixed_expense_periods
    where id=p_period_id and user_id=owner_id for update;
  if not found then raise exception 'La obligación no existe' using errcode='23503'; end if;
  if period_record.transaction_id is null then raise exception 'La obligación no está pagada' using errcode='23514'; end if;
  -- Orden estable: período, avisos, movimiento. No bloquear el movimiento antes de los avisos.
  perform 1 from public.bank_notifications where resolved_transaction_id=period_record.transaction_id
    and user_id=owner_id order by id for update;
  perform set_config('ordia.fixed_expense_flow','on',true);
  perform set_config('ordia.fixed_payment_flow','on',true);
  update public.financial_transactions set deleted_at=now()
    where id=period_record.transaction_id and user_id=owner_id and deleted_at is null;
  if not found then raise exception 'El movimiento del pago no está disponible' using errcode='23514'; end if;
  -- Una reversión es revisión del mismo aviso, no una recepción automática nueva.
  update public.bank_push_notification_attempts set status='skipped',error_code='payment_reversed',
    completed_at=now(),updated_at=now()
    where user_id=owner_id and status in ('queued','processing','failed') and bank_notification_id in (
      select id from public.bank_notifications where user_id=owner_id and resolved_transaction_id=period_record.transaction_id
    );
  perform set_config('ordia.bank_notification_flow','on',true);
  perform set_config('ordia.bank_payment_undo','on',true);
  update public.bank_notifications set status='pending',resolved_transaction_id=null,
    resolution_request_id=null,resolved_at=null
    where user_id=owner_id and resolved_transaction_id=period_record.transaction_id and status='resolved';
  perform set_config('ordia.bank_notification_flow','off',true);
  perform set_config('ordia.bank_payment_undo','off',true);
  update public.fixed_expense_periods set transaction_id=null,payment_request_id=null,paid_amount=null,
    paid_on=null,paid_account_id=null,paid_category_id=null,paid_at=null
    where id=p_period_id and user_id=owner_id;
  perform set_config('ordia.fixed_expense_flow','off',true);
  perform set_config('ordia.fixed_payment_flow','off',true);
end;
$$;
revoke all on function private.undo_fixed_expense_payment_with_notices(uuid) from public,anon;
grant execute on function private.undo_fixed_expense_payment_with_notices(uuid) to authenticated;
create or replace function public.undo_fixed_expense_payment(p_period_id uuid)
returns void language sql security invoker set search_path = '' as $$
  select private.undo_fixed_expense_payment_with_notices(p_period_id);
$$;
