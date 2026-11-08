-- Prueba transaccional local: CUS por usuario, reintentos, dos operaciones similares
-- y vinculación explícita de aviso bancario y PSE a un solo gasto.
begin;

insert into auth.users (id, email) values
  ('a3111111-1111-4111-8111-111111111111', 'recibo-a@ordia.test'),
  ('a3222222-2222-4222-8222-222222222222', 'recibo-b@ordia.test');

set local role authenticated;
set local request.jwt.claim.sub = 'a3111111-1111-4111-8111-111111111111';

do $$
declare
  owner_id uuid := 'a3111111-1111-4111-8111-111111111111';
  account_id uuid := 'a3000000-0000-4000-8000-000000000001';
  category_id uuid := 'a3000000-0000-4000-8000-000000000002';
  tx_id uuid := 'a3000000-0000-4000-8000-000000000003';
  bank_notice public.bank_notifications;
  pse_notice public.bank_notifications;
  retry_notice public.bank_notifications;
  similar_notice public.bank_notifications;
  qr_notice public.bank_notifications;
begin
  insert into public.financial_accounts (id,user_id,name,account_type,currency,initial_balance)
    values (account_id,owner_id,'Cuenta de prueba','bank','COP',100000);
  insert into public.financial_categories (id,user_id,kind,name)
    values (category_id,owner_id,'expense','Pruebas');
  insert into public.financial_transactions
    (id,user_id,kind,account_id,amount,occurred_on,category_id,description,client_request_id)
    values (tx_id,owner_id,'expense',account_id,27500,'2026-11-07',category_id,
      'Pago de prueba','a3000000-0000-4000-8000-000000000004');

  bank_notice := public.create_movement_notice(
    'a3000000-0000-4000-8000-000000000005','Bancolombia','manual','purchase',
    27500,'2026-11-07','10:03',null,null,null,null,null,null,null);
  pse_notice := public.create_movement_notice(
    'a3000000-0000-4000-8000-000000000006','PSE/ACH Colombia','manual','purchase',
    27500,'2026-11-07',null,'EMPRESA DE PRUEBA S.A.S.',null,null,null,null,null,'000123456');
  retry_notice := public.create_movement_notice(
    'a3000000-0000-4000-8000-000000000007','PSE/ACH Colombia','manual','purchase',
    27500,'2026-11-07',null,'EMPRESA DE PRUEBA S.A.S.',null,null,null,null,null,'000123456');
  similar_notice := public.create_movement_notice(
    'a3000000-0000-4000-8000-000000000008','PSE/ACH Colombia','manual','purchase',
    27500,'2026-11-07',null,'EMPRESA DE PRUEBA S.A.S.',null,null,null,null,null,'000123457');
  qr_notice := public.create_movement_notice(
    'a3000000-0000-4000-8000-000000000009','Bancolombia','manual','purchase',
    64000,'2026-11-08','10:03',null,'1234',null,null,null,null,null);
  if retry_notice.id <> pse_notice.id or similar_notice.id = pse_notice.id
    or pse_notice.occurred_time is not null or pse_notice.provider_reference <> '000123456'
    or qr_notice.account_last_digits <> '1234' then
    raise exception 'Falló CUS, hora ausente o cuenta QR';
  end if;
  if (select count(*) from public.financial_transactions where user_id = owner_id) <> 1 then
    raise exception 'Crear pendientes alteró movimientos financieros';
  end if;
  perform public.link_bank_notification_to_transaction(bank_notice.id,tx_id);
  perform public.link_bank_notification_to_transaction(pse_notice.id,tx_id);
  if (select count(*) from public.bank_notifications
      where resolved_transaction_id = tx_id) <> 2 then
    raise exception 'Aviso bancario y PSE no pudieron compartir un gasto elegido';
  end if;
  if (select status from public.bank_notifications where id = similar_notice.id) <> 'pending' then
    raise exception 'Se descartó otra operación legítima parecida';
  end if;
  -- La RPC heredada tampoco puede persistir un PSE sin CUS.
  begin
    perform public.create_bank_notification(
      'a3000000-0000-4000-8000-000000000011','PSE/ACH Colombia','manual','purchase',
      27500,'2026-11-07',null,'EMPRESA DE PRUEBA S.A.S.',null,null,null,null,null);
    set constraints validate_pse_reference_complete_trigger immediate;
    raise exception 'Se aceptó un PSE sin CUS';
  exception when check_violation then null;
  end;
end $$;

set local request.jwt.claim.sub = 'a3111111-1111-4111-8111-111111111111';
select public.ensure_or_replace_bank_email_alias(false);
set local role service_role;
do $$
declare
  alias_part text;
  first_result jsonb;
  retry_result jsonb;
  similar_result jsonb;
begin
  select alias_local_part into alias_part from public.bank_email_aliases
    where user_id = 'a3111111-1111-4111-8111-111111111111' and is_current;
  first_result := public.ingest_movement_notice(
    repeat('a',64),alias_part,repeat('b',64),'PSE/ACH Colombia','purchase',
    27500,'2026-11-07',null,'EMPRESA DE PRUEBA S.A.S.',null,null,null,null,null,'000987654');
  retry_result := public.ingest_movement_notice(
    repeat('c',64),alias_part,repeat('d',64),'PSE/ACH Colombia','purchase',
    27500,'2026-11-07',null,'EMPRESA DE PRUEBA S.A.S.',null,null,null,null,null,'000987654');
  similar_result := public.ingest_movement_notice(
    repeat('e',64),alias_part,repeat('f',64),'PSE/ACH Colombia','purchase',
    27500,'2026-11-07',null,'EMPRESA DE PRUEBA S.A.S.',null,null,null,null,null,'000987655');
  if first_result->>'outcome' <> 'created' or retry_result->>'outcome' <> 'duplicate'
    or similar_result->>'outcome' <> 'created'
    or (select count(*) from public.bank_notifications
        where user_id = 'a3111111-1111-4111-8111-111111111111'
          and provider_reference in ('000987654','000987655')) <> 2 then
    raise exception 'Falló deduplicación automática por CUS: %, %, %',first_result,retry_result,similar_result;
  end if;
end $$;
set local role authenticated;

-- El mismo CUS en otro usuario sigue siendo otra operación privada.
set local request.jwt.claim.sub = 'a3222222-2222-4222-8222-222222222222';
do $$
declare
  other_notice public.bank_notifications;
begin
  other_notice := public.create_movement_notice(
    'a3000000-0000-4000-8000-000000000010','PSE/ACH Colombia','manual','purchase',
    27500,'2026-11-07',null,'EMPRESA DE PRUEBA S.A.S.',null,null,null,null,null,'000123456');
  if other_notice.user_id <> 'a3222222-2222-4222-8222-222222222222' then
    raise exception 'Se cruzó el CUS entre usuarios';
  end if;
end $$;

rollback;
