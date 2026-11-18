-- Solo PostgreSQL local, datos sintéticos y rollback. La carrera real se prueba con el script de concurrencia.
begin;
insert into auth.users(id,email) values
 ('bf111111-1111-4111-8111-111111111111','pago-aviso-a@ordia.test'),
 ('bf222222-2222-4222-8222-222222222222','pago-aviso-b@ordia.test');
set local role authenticated;
set local request.jwt.claim.sub='bf111111-1111-4111-8111-111111111111';
do $$
declare
  bank_id uuid; other_bank uuid; category_id uuid; expense public.fixed_expenses; period public.fixed_expense_periods;
  notice public.bank_notifications; receipt public.bank_notifications; incoming public.bank_notifications;
  tx public.financial_transactions; retry public.financial_transactions;
  request_id uuid := gen_random_uuid(); before_count integer;
  today date := (now() at time zone 'America/Bogota')::date;
begin
  insert into public.financial_accounts(name,account_type,initial_balance) values('Banco de prueba','bank',50000) returning id into bank_id;
  insert into public.financial_accounts(name,account_type) values('Otro banco de prueba','bank') returning id into other_bank;
  insert into public.financial_categories(name,kind) values('Servicios de prueba','expense') returning id into category_id;
  expense := public.create_fixed_expense(gen_random_uuid(),'Internet de prueba',5000,category_id,bank_id,'monthly',today,null);
  select * into period from public.fixed_expense_periods where fixed_expense_id=expense.id and due_date=today;
  if period.id is null then raise exception 'Falta la obligación de prueba'; end if;
  perform set_config('ordia.test_period_id',period.id::text,true);
  notice := public.create_movement_notice(gen_random_uuid(),'Bancolombia','manual','purchase',3000,today,'10:03',null,null,null,null,null,null,null,null,null);
  tx := public.pay_fixed_expense_from_bank_notice(notice.id,period.id,request_id,bank_id,category_id,today,3000);
  retry := public.pay_fixed_expense_from_bank_notice(notice.id,period.id,request_id,bank_id,category_id,today,3000);
  if retry.id <> tx.id or (select count(*) from public.financial_transactions where deleted_at is null) <> 1
    or (select paid_amount from public.fixed_expense_periods where id=period.id) <> 3000
    or (select resolved_transaction_id from public.bank_notifications where id=notice.id) <> tx.id then
    raise exception 'Pago, obligación y aviso no se resolvieron una sola vez';
  end if;
  begin
    perform public.pay_fixed_expense_from_bank_notice(notice.id,period.id,gen_random_uuid(),bank_id,category_id,today,3000);
    raise exception 'Se duplicó el pago con otra solicitud';
  exception when unique_violation then null; end;
  receipt := public.create_movement_notice(gen_random_uuid(),'PSE/ACH Colombia','manual','purchase',3000,today,null,
    'EMPRESA DE PRUEBA',null,null,null,null,null,'000123456',null,null);
  perform public.link_bank_notification_to_transaction(receipt.id,tx.id);
  if (select count(*) from public.financial_transactions) <> 1 then raise exception 'Ya lo registré creó otro gasto'; end if;
  perform public.undo_fixed_expense_payment(period.id);
  if exists(select 1 from public.bank_notifications where id in (notice.id,receipt.id) and
      (status <> 'pending' or resolved_transaction_id is not null or resolution_request_id is not null or resolved_at is not null))
    or exists(select 1 from public.financial_transactions where deleted_at is null)
    or (select transaction_id from public.fixed_expense_periods where id=period.id) is not null then
    raise exception 'Deshacer no reabrió todos los comprobantes o no revirtió el gasto';
  end if;
  if (select initial_balance from public.financial_accounts where id=bank_id) <> 50000 then raise exception 'Cambió el saldo inicial'; end if;

  -- La cuenta explícitamente enlazada se comprueba DESPUÉS de crear el gasto: fallo = rollback integral.
  perform public.upsert_card_account_link('card','1234',bank_id);
  receipt := public.create_movement_notice(gen_random_uuid(),'Bancolombia','manual','purchase',3000,today,'10:05',null,null,'1234','debit',null,null,null,null,null);
  select count(*) into before_count from public.financial_transactions;
  begin
    perform public.pay_fixed_expense_from_bank_notice(receipt.id,period.id,gen_random_uuid(),other_bank,category_id,today,3000);
    raise exception 'Se admitió la cuenta incompatible';
  exception when check_violation then null; end;
  if (select count(*) from public.financial_transactions) <> before_count
    or (select transaction_id from public.fixed_expense_periods where id=period.id) is not null
    or (select status from public.bank_notifications where id=receipt.id) <> 'pending' then
    raise exception 'El fallo dejó cambios parciales';
  end if;
  begin
    perform public.pay_fixed_expense_from_bank_notice(receipt.id,period.id,gen_random_uuid(),bank_id,category_id,today,2999);
    raise exception 'Se admitió importe distinto del aviso';
  exception when check_violation then null; end;
  incoming := public.create_movement_notice(gen_random_uuid(),'Bancolombia','manual','transfer_received',3000,today,'10:06',null,null,null,null,null,null,null,null,null);
  begin
    perform public.pay_fixed_expense_from_bank_notice(incoming.id,period.id,gen_random_uuid(),bank_id,category_id,today,3000);
    raise exception 'Se pagó desde un aviso de entrada';
  exception when check_violation then null; end;
  perform public.pause_fixed_expense(expense.id);
  begin
    perform public.pay_fixed_expense_from_bank_notice(receipt.id,period.id,gen_random_uuid(),bank_id,category_id,today,3000);
    raise exception 'Se pagó una obligación cancelada';
  exception when check_violation then null; end;
end;
$$;
set local request.jwt.claim.sub='bf222222-2222-4222-8222-222222222222';
do $$
begin
  if exists(select 1 from public.bank_notifications) or exists(select 1 from public.fixed_expense_periods) then
    raise exception 'RLS expuso datos ajenos';
  end if;
  begin
    perform public.undo_fixed_expense_payment(current_setting('ordia.test_period_id')::uuid);
    raise exception 'Se deshizo un pago ajeno';
  exception when foreign_key_violation then null; end;
end;
$$;
rollback;
