-- Solo entorno local. Datos sintéticos, sesión autenticada y rollback completo.
begin;
insert into auth.users(id,email) values
  ('ba111111-1111-4111-8111-111111111111','ajuste-a@ordia.test'),
  ('ba222222-2222-4222-8222-222222222222','ajuste-b@ordia.test');

create function pg_temp.assert_adjustment_totals(expected bigint) returns void
language plpgsql security invoker as $$
declare actual bigint;
begin
  select a.initial_balance + coalesce(sum(case
    when t.kind='income' then t.amount
    when t.kind='expense' then -t.amount
    when t.kind='adjustment' and t.adjustment_direction='increase' then t.amount
    when t.kind='adjustment' and t.adjustment_direction='decrease' then -t.amount
    else 0 end),0)
  into actual from public.financial_accounts a
  left join public.financial_transactions t on t.account_id=a.id and t.deleted_at is null
  where a.name='Banco de prueba' group by a.initial_balance;
  if actual is distinct from expected
    or (select coalesce(sum(amount),0) from public.financial_transactions where kind='income' and deleted_at is null) <> 4000
    or (select coalesce(sum(amount),0) from public.financial_transactions where kind='expense' and deleted_at is null) <> 4000
    or (select initial_balance from public.financial_accounts where name='Banco de prueba') <> 50000
    or exists (select 1 from public.financial_transactions t join public.financial_accounts a
      on a.id=t.account_id or a.id=t.destination_account_id where a.name='Efectivo de prueba')
    or exists (select 1 from public.fixed_expense_periods) then
    raise exception 'Saldo %, esperado %; ingresos, gastos, saldo inicial, Efectivo u obligaciones alterados',actual,expected;
  end if;
end;
$$;

set local role authenticated;
set local request.jwt.claim.sub='ba111111-1111-4111-8111-111111111111';
do $$
declare
  bank_id uuid := 'ba000000-0000-4000-8000-000000000001';
  cash_id uuid := 'ba000000-0000-4000-8000-000000000002';
  expense_id uuid := 'ba000000-0000-4000-8000-000000000003';
  income_id uuid := 'ba000000-0000-4000-8000-000000000004';
  request_id uuid := 'ba000000-0000-4000-8000-000000000005';
  tx public.financial_transactions;
  retry public.financial_transactions;
  notice public.bank_notifications;
  notice_type text;
begin
  insert into public.financial_accounts(id,name,account_type,initial_balance) values
    (bank_id,'Banco de prueba','bank',50000),(cash_id,'Efectivo de prueba','cash',10000);
  insert into public.financial_categories(id,kind,name) values
    (expense_id,'expense','Gasto de prueba'),(income_id,'income','Ingreso de prueba');
  perform public.create_financial_transaction(gen_random_uuid(),'income',bank_id,null,4000,'2026-11-11',income_id,null);
  perform public.create_financial_transaction(gen_random_uuid(),'expense',bank_id,null,4000,'2026-11-11',expense_id,null);
  perform pg_temp.assert_adjustment_totals(50000);
  tx := public.create_balance_adjustment(request_id,bank_id,'decrease',3000,'2026-11-11','Conciliación de prueba');
  retry := public.create_balance_adjustment(request_id,bank_id,'decrease',3000,'2026-11-11','Conciliación de prueba');
  if tx.id <> retry.id or (select count(*) from public.financial_transactions where kind='adjustment') <> 1
    or tx.category_id is not null or tx.destination_account_id is not null then
    raise exception 'El ajuste no es único o tiene categoría/destino';
  end if;
  perform pg_temp.assert_adjustment_totals(47000);
  update public.financial_transactions set amount=2000 where id=tx.id;
  perform pg_temp.assert_adjustment_totals(48000);
  -- Ningún aviso puede resolver un ajuste como ingreso, gasto o transferencia.
  foreach notice_type in array array['purchase','transfer_sent','transfer_received','cash_deposit_received'] loop
    notice := public.create_movement_notice(gen_random_uuid(),'Bancolombia','manual',notice_type,
      2000,'2026-11-11','10:00',null,null,null,null,null,null,null,
      case when notice_type='cash_deposit_received' then 'CORRESPONSAL DE PRUEBA' end,
      case when notice_type='cash_deposit_received' then 'MUNICIPIO DE PRUEBA' end);
    begin
      perform public.link_bank_notification_to_transaction(notice.id,tx.id);
      raise exception 'Se vinculó un ajuste a un aviso';
    exception when check_violation then null; end;
  end loop;
  begin
    update public.financial_transactions set deleted_at=now(),adjustment_direction='increase' where id=tx.id;
    raise exception 'Se permitió cambiar la dirección al eliminar';
  exception when check_violation then null; end;
  update public.financial_transactions set deleted_at=now() where id=tx.id;
  perform pg_temp.assert_adjustment_totals(50000);
  begin
    update public.financial_transactions set amount=1000 where id=tx.id;
    raise exception 'Se modificó un ajuste eliminado';
  exception when check_violation then null; end;
  tx := public.create_balance_adjustment(gen_random_uuid(),bank_id,'increase',5000,'2026-11-11',null);
  perform pg_temp.assert_adjustment_totals(55000);
  update public.financial_transactions set adjustment_direction='decrease' where id=tx.id;
  perform pg_temp.assert_adjustment_totals(45000);
  update public.financial_transactions set deleted_at=now() where id=tx.id;
  perform pg_temp.assert_adjustment_totals(50000);

  -- CHECK conserva los importes positivos y la forma de cada tipo.
  begin
    perform public.create_balance_adjustment(gen_random_uuid(),bank_id,null,1000,'2026-11-11',null);
    raise exception 'Se admitió dirección ausente';
  exception when check_violation then null; end;
  begin
    perform public.create_balance_adjustment(gen_random_uuid(),bank_id,'invalid',1000,'2026-11-11',null);
    raise exception 'Se admitió dirección desconocida';
  exception when check_violation then null; end;
  begin
    perform public.create_balance_adjustment(gen_random_uuid(),bank_id,'decrease',-1000,'2026-11-11',null);
    raise exception 'Se admitió importe negativo';
  exception when check_violation then null; end;
  begin
    perform public.create_balance_adjustment(gen_random_uuid(),bank_id,'increase',0,'2026-11-11',null);
    raise exception 'Se admitió importe cero';
  exception when check_violation then null; end;
  begin
    perform public.create_balance_adjustment(gen_random_uuid(),bank_id,'increase',9000000000001,'2026-11-11',null);
    raise exception 'Se admitió importe excesivo';
  exception when check_violation then null; end;
  begin
    insert into public.financial_transactions(client_request_id,kind,account_id,amount,occurred_on,category_id,adjustment_direction)
      values(gen_random_uuid(),'adjustment',bank_id,1000,'2026-11-11',expense_id,'increase');
    raise exception 'Se admitió categoría en ajuste';
  exception when check_violation then null; end;
  begin
    insert into public.financial_transactions(client_request_id,kind,account_id,destination_account_id,amount,occurred_on,adjustment_direction)
      values(gen_random_uuid(),'adjustment',bank_id,cash_id,1000,'2026-11-11','increase');
    raise exception 'Se admitió destino en ajuste';
  exception when check_violation then null; end;
  begin
    insert into public.financial_transactions(client_request_id,kind,account_id,amount,occurred_on,category_id,adjustment_direction)
      values(gen_random_uuid(),'expense',bank_id,1000,'2026-11-11',expense_id,'increase');
    raise exception 'Se admitió dirección de ajuste en gasto';
  exception when check_violation then null; end;
  update public.financial_accounts set archived_at=now() where id=bank_id;
  begin
    perform public.create_balance_adjustment(gen_random_uuid(),bank_id,'increase',1000,'2026-11-11',null);
    raise exception 'Se admitió ajuste nuevo en cuenta archivada';
  exception when check_violation then null; end;
end;
$$;

set local request.jwt.claim.sub='ba222222-2222-4222-8222-222222222222';
do $$
declare bank_id uuid; tx public.financial_transactions; affected integer;
begin
  if exists(select 1 from public.financial_transactions) or exists(select 1 from public.financial_accounts) then
    raise exception 'RLS expuso datos de otro usuario';
  end if;
  begin
    perform public.create_balance_adjustment(gen_random_uuid(),'ba000000-0000-4000-8000-000000000001','increase',1000,'2026-11-11',null);
    raise exception 'Se admitió una cuenta ajena';
  exception when foreign_key_violation or insufficient_privilege then null; end;
  update public.financial_transactions set amount=1 where user_id='ba111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Se editaron movimientos ajenos'; end if;
  update public.financial_transactions set deleted_at=now() where user_id='ba111111-1111-4111-8111-111111111111';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'Se eliminaron movimientos ajenos'; end if;
  insert into public.financial_accounts(name,account_type) values ('Otra cuenta de prueba','bank') returning id into bank_id;
  -- Mismo UUID de solicitud en otro usuario: operación legítima e independiente.
  tx := public.create_balance_adjustment('ba000000-0000-4000-8000-000000000005',bank_id,'increase',1000,'2026-11-11',null);
  if tx.user_id <> auth.uid() or tx.amount <> 1000 then raise exception 'Solicitud mezclada entre usuarios'; end if;
  begin
    update public.financial_transactions set user_id='ba111111-1111-4111-8111-111111111111' where id=tx.id;
    raise exception 'Se cambió propietario';
  exception when check_violation or insufficient_privilege then null; end;
end;
$$;
reset role;
do $$
begin
  if has_function_privilege('anon','public.create_balance_adjustment(uuid,uuid,text,bigint,date,text)','execute')
    or not (select relrowsecurity from pg_class where oid='public.financial_transactions'::regclass)
    or not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='financial_transactions') then
    raise exception 'Permisos, RLS o publicación Realtime incorrectos';
  end if;
end;
$$;
rollback;
