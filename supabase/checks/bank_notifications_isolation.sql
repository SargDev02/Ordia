-- Prueba SQL de aislamiento, validación de «Ya lo registré» e inmutabilidad para «Movimientos por revisar»
-- Exclusivamente para PostgreSQL local de pruebas (no ejecutar en producción).
-- Dos usuarios aislados: A y B con rol 'authenticated' (sin service_role).
-- Valida:
-- 1. Creación de pendientes sin alterar saldos ni crear movimientos.
-- 2. Tarjetas con la misma terminación (0541) en ambos usuarios sin cruce de datos.
-- 3. Aislamiento RLS estricto: B no puede leer, descartar ni vincular avisos o movimientos ajenos de A.
-- 4. En «Ya lo registré» (link_bank_notification_to_transaction): propietario, vigencia, importe exacto,
--    tipo, sentido y cuenta conocida (origen en salidas y destino en entradas para transferencias propias).
-- 5. La resolución no puede sobrescribirse (ni por RPC ni por UPDATE directo).
-- 6. Si falla la creación del movimiento, el aviso permanece en estado 'pending'.
-- 7. Limpieza completa mediante ROLLBACK.

begin;

do $$ begin
  if exists (select 1 from auth.users where id in ('81111111-1111-4111-8111-111111111111', '82222222-2222-4222-8222-222222222222')) then
    raise exception 'Test fixture already exists; refusing to reuse it';
  end if;
end $$;

insert into auth.users (id, email) values
('81111111-1111-4111-8111-111111111111', 'bank-fixture-a@ordia.test'),
('82222222-2222-4222-8222-222222222222', 'bank-fixture-b@ordia.test');

-- -------------------------------------------------------------
-- USUARIO A: Crear cuentas, categorías, avisos y validaciones
-- -------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '81111111-1111-4111-8111-111111111111';

do $$
declare
  acc_a1 uuid := '8a000000-0000-4000-8000-000000000001';
  acc_a2 uuid := '8a000000-0000-4000-8000-000000000002';
  cat_expense uuid := '8a000000-0000-4000-8000-000000000010';
  cat_income uuid := '8a000000-0000-4000-8000-000000000011';
  cat_archived uuid := '8a000000-0000-4000-8000-000000000012';
  notif_1 public.bank_notifications;
  notif_2 public.bank_notifications;
  notif_in public.bank_notifications;
  notif_fail public.bank_notifications;
  notif_retry public.bank_notifications;
  tx_res public.financial_transactions;
  tx_retry public.financial_transactions;
  tx_wrong_amount uuid := '8a000000-0000-4000-8000-000000000041';
  tx_deleted uuid := '8a000000-0000-4000-8000-000000000042';
  tx_wrong_kind uuid := '8a000000-0000-4000-8000-000000000043';
  tx_wrong_account uuid := '8a000000-0000-4000-8000-000000000044';
  tx_transfer_wrong_dir uuid := '8a000000-0000-4000-8000-000000000045';
  tx_transfer_right_dir uuid := '8a000000-0000-4000-8000-000000000046';
  card_link public.bank_card_account_links;
  balance_before_fail bigint;
  balance_after_fail bigint;
  tx_count_before_link integer;
  acc_a1_before_link bigint;
  acc_a2_before_link bigint;
  tx_count_after_link integer;
  acc_a1_after_link bigint;
  acc_a2_after_link bigint;
begin
  insert into public.financial_accounts (id, user_id, name, account_type, currency, initial_balance)
  values
    (acc_a1, '81111111-1111-4111-8111-111111111111', 'Bancolombia Ahorros A 8422', 'bank', 'COP', 1000000),
    (acc_a2, '81111111-1111-4111-8111-111111111111', 'Bancolombia Corriente A', 'bank', 'COP', 500000);

  insert into public.financial_categories (id, user_id, kind, name, archived_at)
  values
    (cat_expense, '81111111-1111-4111-8111-111111111111', 'expense', 'Hogar', null),
    (cat_income, '81111111-1111-4111-8111-111111111111', 'income', 'Transferencias Recibidas', null),
    (cat_archived, '81111111-1111-4111-8111-111111111111', 'expense', 'Archivada', null);

  update public.financial_categories
  set archived_at = now()
  where id = cat_archived;

  -- 1. Asociar tarjeta 0541 y cuenta 8422 a acc_a1 para el usuario A
  card_link := public.upsert_card_account_link('card', '0541', acc_a1);
  if card_link.last_digits <> '0541' or card_link.account_id <> acc_a1 then
    raise exception 'TEST FAILED: upsert_card_account_link failed for User A';
  end if;
  perform public.upsert_card_account_link('account', '8422', acc_a1);

  -- 2. Crear aviso pendiente (compra en HOMECENTER RIONEGRO por $39.900)
  notif_1 := public.create_bank_notification(
    '8a000000-0000-4000-8000-000000000020',
    'Bancolombia', 'manual', 'purchase', 39900, '2026-10-17'::date, '13:17',
    'HOMECENTER RIONEGRO', null, '0541', 'debit', null, null
  );

  if notif_1.status <> 'pending' or notif_1.amount <> 39900 then
    raise exception 'TEST FAILED: pending notification not created properly';
  end if;

  if (select count(*) from public.financial_transactions where user_id = '81111111-1111-4111-8111-111111111111') <> 0 then
    raise exception 'TEST FAILED: pending notification created transactions unexpectedly';
  end if;

  -- 3. Idempotencia de creación ante reintento con mismo client_request_id
  notif_retry := public.create_bank_notification(
    '8a000000-0000-4000-8000-000000000020',
    'Bancolombia', 'manual', 'purchase', 39900, '2026-10-17'::date, '13:17',
    'HOMECENTER RIONEGRO', null, '0541', 'debit', null, null
  );
  if notif_retry.id <> notif_1.id then
    raise exception 'TEST FAILED: notification creation idempotency failed';
  end if;

  -- 4. Fallo al crear el movimiento debe dejar el aviso en 'pending' y sin cambiar el saldo
  notif_fail := public.create_bank_notification(
    '8a000000-0000-4000-8000-000000000029',
    'Bancolombia', 'manual', 'purchase', 50000, '2026-10-18'::date, '09:00',
    'TIENDA BARRIO', null, '0541', 'debit', null, null
  );

  select a.initial_balance + coalesce(sum(
    case
      when t.deleted_at is not null then 0
      when t.kind = 'income' and t.account_id = a.id then t.amount
      when t.kind = 'expense' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.destination_account_id = a.id then t.amount
      else 0
    end
  ), 0) into balance_before_fail
  from public.financial_accounts a
  left join public.financial_transactions t on (t.account_id = a.id or t.destination_account_id = a.id)
  where a.id = acc_a1
  group by a.initial_balance;

  begin
    perform public.confirm_bank_notification_as_transaction(
      notif_fail.id,
      '8a000000-0000-4000-8000-000000000039',
      'expense',
      acc_a1,
      cat_archived,
      'Intento fallido con categoría archivada',
      '2026-10-18'::date,
      false, null, null
    );
    raise exception 'TEST FAILED: archived category confirmation should have failed';
  exception when sqlstate '23503' then
    null;
  end;

  -- Fallo durante el INSERT en financial_transactions (restricción de longitud de descripción)
  begin
    perform public.confirm_bank_notification_as_transaction(
      notif_fail.id,
      '8a000000-0000-4000-8000-000000000037',
      'expense',
      acc_a1,
      cat_expense,
      repeat('x', 241),
      '2026-10-18'::date,
      false, null, null
    );
    raise exception 'TEST FAILED: invalid description insert should have failed';
  exception when sqlstate '23514' then
    null;
  end;

  select a.initial_balance + coalesce(sum(
    case
      when t.deleted_at is not null then 0
      when t.kind = 'income' and t.account_id = a.id then t.amount
      when t.kind = 'expense' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.destination_account_id = a.id then t.amount
      else 0
    end
  ), 0) into balance_after_fail
  from public.financial_accounts a
  left join public.financial_transactions t on (t.account_id = a.id or t.destination_account_id = a.id)
  where a.id = acc_a1
  group by a.initial_balance;

  select * into notif_fail from public.bank_notifications where id = notif_fail.id;
  if notif_fail.status <> 'pending' or notif_fail.resolved_transaction_id is not null or balance_after_fail <> balance_before_fail then
    raise exception 'TEST FAILED: failed confirmation altered status or balance';
  end if;

  -- 5. Confirmar aviso 1 como gasto atómico
  tx_res := public.confirm_bank_notification_as_transaction(
    notif_1.id,
    '8a000000-0000-4000-8000-000000000030',
    'expense',
    acc_a1,
    cat_expense,
    'HOMECENTER RIONEGRO',
    '2026-10-17'::date,
    true, 'card', '0541'
  );

  if tx_res.amount <> 39900 or tx_res.account_id <> acc_a1 then
    raise exception 'TEST FAILED: confirmation as transaction failed';
  end if;

  -- 6. Reintento idéntico (mismo request_id) es idempotente; request_id distinto o UPDATE directo NO sobrescribe
  tx_retry := public.confirm_bank_notification_as_transaction(
    notif_1.id,
    '8a000000-0000-4000-8000-000000000030',
    'expense',
    acc_a1,
    cat_expense,
    'HOMECENTER RIONEGRO',
    '2026-10-17'::date,
    false, null, null
  );
  if tx_retry.id <> tx_res.id then
    raise exception 'TEST FAILED: retry confirmation returned different transaction';
  end if;

  begin
    perform public.confirm_bank_notification_as_transaction(
      notif_1.id,
      '8a000000-0000-4000-8000-000000000038',
      'expense',
      acc_a2,
      cat_expense,
      'Intento sobrescribir',
      '2026-10-17'::date,
      false, null, null
    );
    raise exception 'TEST FAILED: resolved notification was overwritten by second request_id';
  exception when sqlstate '23505' then
    null;
  end;

  -- 6b. Verificar privilegios mínimos y que activar explícitamente ordia.bank_notification_flow bajo ROLE authenticated
  --     NO permite escrituras directas en bank_notifications ni en bank_card_account_links.
  if not has_table_privilege('authenticated', 'public.bank_notifications', 'SELECT')
    or has_table_privilege('authenticated', 'public.bank_notifications', 'INSERT')
    or has_table_privilege('authenticated', 'public.bank_notifications', 'UPDATE')
    or has_table_privilege('authenticated', 'public.bank_notifications', 'DELETE')
    or has_table_privilege('authenticated', 'public.bank_notifications', 'TRUNCATE')
    or has_table_privilege('anon', 'public.bank_notifications', 'SELECT')
  then
    raise exception 'TEST FAILED: unexpected table privileges on bank_notifications';
  end if;

  if not has_table_privilege('authenticated', 'public.bank_card_account_links', 'SELECT')
    or has_table_privilege('authenticated', 'public.bank_card_account_links', 'INSERT')
    or has_table_privilege('authenticated', 'public.bank_card_account_links', 'UPDATE')
    or has_table_privilege('authenticated', 'public.bank_card_account_links', 'DELETE')
    or has_table_privilege('authenticated', 'public.bank_card_account_links', 'TRUNCATE')
    or has_table_privilege('anon', 'public.bank_card_account_links', 'SELECT')
  then
    raise exception 'TEST FAILED: unexpected table privileges on bank_card_account_links';
  end if;

  perform set_config('ordia.bank_notification_flow', 'on', true);

  begin
    insert into public.bank_notifications (
      user_id, client_request_id, notification_type, amount, occurred_on, occurred_time
    ) values (
      '81111111-1111-4111-8111-111111111111', '8a000000-0000-4000-8000-000000000099',
      'purchase', 10000, '2026-10-31'::date, '12:00'
    );
    raise exception 'TEST FAILED: direct INSERT on bank_notifications succeeded after setting GUC';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    update public.bank_notifications set status = 'pending', resolved_transaction_id = null, resolution_request_id = null, resolved_at = null where id = notif_1.id;
    raise exception 'TEST FAILED: direct UPDATE on resolved row bypassed privilege protection';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    update public.bank_notifications set status = 'dismissed', dismissed_at = now() where id = notif_fail.id;
    raise exception 'TEST FAILED: direct UPDATE on pending row bypassed privilege protection';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    delete from public.bank_notifications where id = notif_fail.id;
    raise exception 'TEST FAILED: direct DELETE on bank_notifications succeeded';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    insert into public.bank_card_account_links (user_id, identifier_type, last_digits, account_id)
    values ('81111111-1111-4111-8111-111111111111', 'card', '7777', acc_a1);
    raise exception 'TEST FAILED: direct INSERT on bank_card_account_links succeeded after setting GUC';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    update public.bank_card_account_links set account_id = acc_a2 where id = card_link.id;
    raise exception 'TEST FAILED: direct UPDATE on bank_card_account_links succeeded after setting GUC';
  exception when sqlstate '42501' then
    null;
  end;

  begin
    delete from public.bank_card_account_links where id = card_link.id;
    raise exception 'TEST FAILED: direct DELETE on bank_card_account_links succeeded after setting GUC';
  exception when sqlstate '42501' then
    null;
  end;

  perform set_config('ordia.bank_notification_flow', 'off', true);

  -- 7. Confirmar aviso 2 (transferencia enviada desde *8422 por $200.000) como transferencia única
  notif_2 := public.create_bank_notification(
    '8a000000-0000-4000-8000-000000000021',
    'Bancolombia', 'manual', 'transfer_sent', 200000, '2026-10-20'::date, '21:15',
    null, '8422', null, null, null, null
  );

  tx_res := public.confirm_bank_notification_as_transfer(
    notif_2.id,
    '8a000000-0000-4000-8000-000000000031',
    acc_a1,
    acc_a2,
    'Transferencia a corriente',
    '2026-10-20'::date,
    true, 'account', '8422'
  );

  if tx_res.kind <> 'transfer' or tx_res.account_id <> acc_a1 or tx_res.destination_account_id <> acc_a2 or tx_res.amount <> 200000 then
    raise exception 'TEST FAILED: confirmation as transfer failed';
  end if;

  -- 8. Validar estrictamente «Ya lo registré» (transferencia recibida en cuenta **8422 = acc_a1 por $22.000)
  notif_in := public.create_bank_notification(
    '8a000000-0000-4000-8000-000000000022',
    'Bancolombia', 'manual', 'transfer_received', 22000, '2026-10-31'::date, '13:28',
    null, '8422', null, null, null, null
  );

  insert into public.financial_transactions (
    id, user_id, client_request_id, kind, account_id, destination_account_id,
    amount, occurred_on, category_id, description, deleted_at
  ) values
    (tx_wrong_amount, '81111111-1111-4111-8111-111111111111', '8a000000-0000-4000-8000-000000000051', 'income', acc_a1, null, 22500, '2026-10-31'::date, cat_income, 'Otro monto', null),
    (tx_deleted, '81111111-1111-4111-8111-111111111111', '8a000000-0000-4000-8000-000000000052', 'income', acc_a1, null, 22000, '2026-10-31'::date, cat_income, 'Borrado', null),
    (tx_wrong_kind, '81111111-1111-4111-8111-111111111111', '8a000000-0000-4000-8000-000000000053', 'expense', acc_a1, null, 22000, '2026-10-31'::date, cat_expense, 'Es gasto no ingreso', null),
    (tx_wrong_account, '81111111-1111-4111-8111-111111111111', '8a000000-0000-4000-8000-000000000054', 'income', acc_a2, null, 22000, '2026-10-31'::date, cat_income, 'Otra cuenta', null),
    -- Transferencia propia donde acc_a1 es ORIGEN en vez de DESTINO (sentido inverso al aviso recibido)
    (tx_transfer_wrong_dir, '81111111-1111-4111-8111-111111111111', '8a000000-0000-4000-8000-000000000055', 'transfer', acc_a1, acc_a2, 22000, '2026-10-31'::date, null, 'Salida desde 8422', null),
    -- Transferencia propia válida donde acc_a1 (cuenta **8422) es DESTINO
    (tx_transfer_right_dir, '81111111-1111-4111-8111-111111111111', '8a000000-0000-4000-8000-000000000056', 'transfer', acc_a2, acc_a1, 22000, '2026-10-31'::date, null, 'Entrada hacia 8422', null);

  update public.financial_transactions
  set deleted_at = now()
  where id = tx_deleted;

  select count(*)::integer into tx_count_before_link
  from public.financial_transactions
  where user_id = '81111111-1111-4111-8111-111111111111' and deleted_at is null;

  select a.initial_balance + coalesce(sum(
    case
      when t.deleted_at is not null then 0
      when t.kind = 'income' and t.account_id = a.id then t.amount
      when t.kind = 'expense' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.destination_account_id = a.id then t.amount
      else 0
    end
  ), 0) into acc_a1_before_link
  from public.financial_accounts a
  left join public.financial_transactions t on (t.account_id = a.id or t.destination_account_id = a.id)
  where a.id = acc_a1
  group by a.initial_balance;

  select a.initial_balance + coalesce(sum(
    case
      when t.deleted_at is not null then 0
      when t.kind = 'income' and t.account_id = a.id then t.amount
      when t.kind = 'expense' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.destination_account_id = a.id then t.amount
      else 0
    end
  ), 0) into acc_a2_before_link
  from public.financial_accounts a
  left join public.financial_transactions t on (t.account_id = a.id or t.destination_account_id = a.id)
  where a.id = acc_a2
  group by a.initial_balance;

  -- Todos los candidatos inválidos deben rechazarse
  begin perform public.link_bank_notification_to_transaction(notif_in.id, tx_wrong_amount); raise exception 'TEST FAILED: linked wrong amount'; exception when sqlstate '23514' then null; end;
  begin perform public.link_bank_notification_to_transaction(notif_in.id, tx_deleted); raise exception 'TEST FAILED: linked deleted tx'; exception when sqlstate '23503' then null; end;
  begin perform public.link_bank_notification_to_transaction(notif_in.id, tx_wrong_kind); raise exception 'TEST FAILED: linked wrong kind'; exception when sqlstate '23514' then null; end;
  begin perform public.link_bank_notification_to_transaction(notif_in.id, tx_wrong_account); raise exception 'TEST FAILED: linked wrong known account'; exception when sqlstate '23514' then null; end;
  begin perform public.link_bank_notification_to_transaction(notif_in.id, tx_transfer_wrong_dir); raise exception 'TEST FAILED: linked transfer with wrong destination'; exception when sqlstate '23514' then null; end;

  -- El candidato con destino correcto (acc_a1) sí debe vincularse sin crear movimientos ni alterar saldos
  perform public.link_bank_notification_to_transaction(notif_in.id, tx_transfer_right_dir);

  select count(*)::integer into tx_count_after_link
  from public.financial_transactions
  where user_id = '81111111-1111-4111-8111-111111111111' and deleted_at is null;

  select a.initial_balance + coalesce(sum(
    case
      when t.deleted_at is not null then 0
      when t.kind = 'income' and t.account_id = a.id then t.amount
      when t.kind = 'expense' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.destination_account_id = a.id then t.amount
      else 0
    end
  ), 0) into acc_a1_after_link
  from public.financial_accounts a
  left join public.financial_transactions t on (t.account_id = a.id or t.destination_account_id = a.id)
  where a.id = acc_a1
  group by a.initial_balance;

  select a.initial_balance + coalesce(sum(
    case
      when t.deleted_at is not null then 0
      when t.kind = 'income' and t.account_id = a.id then t.amount
      when t.kind = 'expense' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.account_id = a.id then -t.amount
      when t.kind = 'transfer' and t.destination_account_id = a.id then t.amount
      else 0
    end
  ), 0) into acc_a2_after_link
  from public.financial_accounts a
  left join public.financial_transactions t on (t.account_id = a.id or t.destination_account_id = a.id)
  where a.id = acc_a2
  group by a.initial_balance;

  select * into notif_in from public.bank_notifications where id = notif_in.id;
  if notif_in.status <> 'resolved'
    or notif_in.resolved_transaction_id <> tx_transfer_right_dir
    or tx_count_after_link <> tx_count_before_link
    or acc_a1_after_link <> acc_a1_before_link
    or acc_a2_after_link <> acc_a2_before_link
  then
    raise exception 'TEST FAILED: linking to valid destination transfer failed or altered balances';
  end if;
end $$;

-- -------------------------------------------------------------
-- USUARIO B: Verificar aislamiento estricto y rechazo de vínculo ajeno
-- -------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '82222222-2222-4222-8222-222222222222';

do $$
declare
  acc_b1 uuid := '8b000000-0000-4000-8000-000000000001';
  b_card_link public.bank_card_account_links;
  notif_b public.bank_notifications;
begin
  insert into public.financial_accounts (id, user_id, name, account_type, currency, initial_balance)
  values (acc_b1, '82222222-2222-4222-8222-222222222222', 'Bancolombia B', 'bank', 'COP', 300000);

  -- 1. B no puede ver avisos ni enlaces de A
  if (select count(*) from public.bank_notifications) <> 0 then
    raise exception 'TEST FAILED: RLS leak, User B can see User A bank notifications';
  end if;

  if (select count(*) from public.bank_card_account_links) <> 0 then
    raise exception 'TEST FAILED: RLS leak, User B can see User A card account links';
  end if;

  -- 2. B puede registrar su propia tarjeta terminada en 0541 sin colisionar ni cruzar con A
  b_card_link := public.upsert_card_account_link('card', '0541', acc_b1);
  if b_card_link.last_digits <> '0541' or b_card_link.account_id <> acc_b1 then
    raise exception 'TEST FAILED: User B could not register card 0541';
  end if;

  if (select count(*) from public.bank_card_account_links where last_digits = '0541') <> 1 then
    raise exception 'TEST FAILED: User B should only see their own 0541 card';
  end if;

  -- 3. B crea un aviso propio con el mismo importe ($22.000) e intenta vincularlo a un movimiento ajeno (del usuario A)
  notif_b := public.create_bank_notification(
    '8b000000-0000-4000-8000-000000000020',
    'Bancolombia', 'manual', 'transfer_received', 22000, '2026-10-31'::date, '13:28',
    null, null, null, null, null, null
  );

  begin
    perform public.link_bank_notification_to_transaction(notif_b.id, '8a000000-0000-4000-8000-000000000044');
    raise exception 'TEST FAILED: User B linked notification to User A transaction';
  exception when sqlstate '23503' then
    null;
  end;

  select * into notif_b from public.bank_notifications where id = notif_b.id;
  if notif_b.status <> 'pending' or notif_b.resolved_transaction_id is not null then
    raise exception 'TEST FAILED: User B notification changed status after rejected cross-user link';
  end if;

  -- 4. B tampoco puede asociar su tarjeta a una cuenta ajena (acc_a1)
  begin
    perform public.upsert_card_account_link('card', '9999', '8a000000-0000-4000-8000-000000000001');
    raise exception 'TEST FAILED: User B linked card to User A account';
  exception when sqlstate '23503' then
    null;
  end;

  -- 5. B no puede descartar ni modificar un aviso de A
  begin
    perform public.dismiss_bank_notification('8a000000-0000-4000-8000-000000000029');
    raise exception 'TEST FAILED: User B could dismiss User A notification';
  exception when sqlstate '23503' then
    null;
  end;
end $$;

-- -------------------------------------------------------------
-- USUARIO A DE NUEVO: Confirmar que las acciones de B no tocaron su tarjeta 0541 ni sus avisos
-- -------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '81111111-1111-4111-8111-111111111111';

do $$
begin
  if (select count(*) from public.bank_card_account_links where identifier_type = 'card' and last_digits = '0541') <> 1 then
    raise exception 'TEST FAILED: User A lost or duplicated card 0541 link after User B registered 0541';
  end if;

  if (select account_id from public.bank_card_account_links where identifier_type = 'card' and last_digits = '0541') <> '8a000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'TEST FAILED: User A card 0541 link account_id changed unexpectedly';
  end if;

  if (select count(*) from public.bank_notifications where user_id <> '81111111-1111-4111-8111-111111111111') <> 0 then
    raise exception 'TEST FAILED: User A can see User B notifications';
  end if;
end $$;

rollback;
