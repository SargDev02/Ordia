-- Solo PostgreSQL local: fixtures sintéticos y rollback completo.
begin;
insert into auth.users(id,email) values ('b4111111-1111-4111-8111-111111111111','consignacion@ordia.test');
set local role authenticated;
set local request.jwt.claim.sub = 'b4111111-1111-4111-8111-111111111111';
do $$
declare
  bank_id uuid := 'b4000000-0000-4000-8000-000000000001';
  cash_id uuid := 'b4000000-0000-4000-8000-000000000002';
  cat_id uuid := 'b4000000-0000-4000-8000-000000000003';
  notice public.bank_notifications;
  extra public.bank_notifications;
  tx public.financial_transactions;
  retry public.financial_transactions;
  request_id uuid := 'b4000000-0000-4000-8000-000000000004';
begin
  insert into public.financial_accounts(id,name,account_type,initial_balance) values
    (bank_id,'Banco de prueba','bank',5000),(cash_id,'Efectivo','cash',10000);
  insert into public.financial_categories(id,kind,name) values(cat_id,'income','Consignaciones de prueba');
  notice := public.create_movement_notice(gen_random_uuid(),'Bancolombia','manual','cash_deposit_received',
    3000,'2026-06-09','17:04',null,null,null,null,null,null,null,'CORRESPONSAL DE PRUEBA','MUNICIPIO DE PRUEBA');
  if notice.correspondent_name <> 'CORRESPONSAL DE PRUEBA' or notice.municipality <> 'MUNICIPIO DE PRUEBA'
    or notice.counterparty_name is not null or notice.account_last_digits is not null
    or (select count(*) from public.financial_transactions) <> 0 then
    raise exception 'Pegar una consignación inventó datos o creó un movimiento';
  end if;
  begin
    perform public.confirm_bank_notification_as_transaction(notice.id,request_id,'expense',bank_id,cat_id,null,null);
    raise exception 'Se aceptó un gasto';
  exception when check_violation then null; end;
  begin
    perform public.confirm_bank_notification_as_transaction(notice.id,request_id,'income',cash_id,cat_id,null,null);
    raise exception 'Se aceptó una cuenta de efectivo como receptora';
  exception when check_violation then null; end;
  begin
    perform public.confirm_bank_notification_as_transfer(notice.id,request_id,cash_id,bank_id,null,null);
    raise exception 'Se aceptó descontar Efectivo mediante una transferencia';
  exception when check_violation then null; end;
  tx := public.confirm_bank_notification_as_transaction(notice.id,request_id,'income',bank_id,cat_id,'Consignación de prueba',null);
  retry := public.confirm_bank_notification_as_transaction(notice.id,request_id,'income',bank_id,cat_id,'Consignación de prueba',null);
  if retry.id <> tx.id or tx.kind <> 'income' or tx.account_id <> bank_id or tx.destination_account_id is not null then
    raise exception 'La confirmación no produjo un ingreso idempotente';
  end if;
  begin
    perform public.confirm_bank_notification_as_transaction(notice.id,gen_random_uuid(),'income',bank_id,cat_id,null,null);
    raise exception 'Se permitió registrar dos veces la consignación';
  exception when unique_violation then null; end;
  extra := public.create_movement_notice(gen_random_uuid(),'Bancolombia','manual','cash_deposit_received',
    3000,'2026-06-09','17:04',null,null,null,null,null,null,null,'CORRESPONSAL DE PRUEBA','MUNICIPIO DE PRUEBA');
  perform public.link_bank_notification_to_transaction(extra.id,tx.id);
  extra := public.create_movement_notice(gen_random_uuid(),'Bancolombia','manual','cash_deposit_received',
    3000,'2026-06-09','17:04',null,null,null,null,null,null,null,'CORRESPONSAL DE PRUEBA','MUNICIPIO DE PRUEBA');
  perform public.dismiss_bank_notification(extra.id);
  if (select count(*) from public.financial_transactions) <> 1
    or (select sum(amount) from public.financial_transactions where kind='income') <> 3000
    or (select initial_balance from public.financial_accounts where id=bank_id)
      + (select sum(amount) from public.financial_transactions where account_id=bank_id and kind='income') <> 8000
    or exists(select 1 from public.financial_transactions where account_id=cash_id or destination_account_id=cash_id)
    or (select initial_balance from public.financial_accounts where id=cash_id) <> 10000 then
    raise exception 'Se duplicó el ingreso o cambió Efectivo al confirmar, vincular o descartar';
  end if;
end $$;
select public.ensure_or_replace_bank_email_alias(false);
set local role service_role;
do $$
declare
  alias_part text;
  result jsonb;
  retry jsonb;
  notice public.bank_notifications;
begin
  select alias_local_part into alias_part from public.bank_email_aliases
    where user_id='b4111111-1111-4111-8111-111111111111' and is_current;
  result := public.ingest_movement_notice(repeat('1',64),alias_part,repeat('2',64),'Bancolombia',
    'cash_deposit_received',3000,'2026-06-09','17:04',null,null,null,null,null,null,null,'CORRESPONSAL DE PRUEBA','MUNICIPIO DE PRUEBA');
  retry := public.ingest_movement_notice(repeat('1',64),alias_part,repeat('2',64),'Bancolombia',
    'cash_deposit_received',3000,'2026-06-09','17:04',null,null,null,null,null,null,null,'CORRESPONSAL DE PRUEBA','MUNICIPIO DE PRUEBA');
  select * into notice from public.bank_notifications where id=(result->>'notification_id')::uuid;
  if result->>'outcome' <> 'created' or retry->>'outcome' <> 'duplicate'
    or notice.correspondent_name <> 'CORRESPONSAL DE PRUEBA' or notice.municipality <> 'MUNICIPIO DE PRUEBA'
    or notice.notification_type <> 'cash_deposit_received' or notice.status <> 'pending'
    or (select count(*) from public.financial_transactions) <> 1 then
    raise exception 'Recibir el correo alteró saldos o duplicó el pendiente';
  end if;
end $$;
rollback;
