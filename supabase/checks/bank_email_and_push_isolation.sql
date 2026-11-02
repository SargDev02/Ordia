-- Prueba SQL de aislamiento, seguridad de privilegios, ciclo de vida de alias de Gmail,
-- idempotencia de entregas e independencia de canales Web Push para avisos bancarios.
-- Exclusivamente para PostgreSQL local de pruebas (no ejecutar en producción).
-- Limpieza completa garantizada mediante ROLLBACK al final.

begin;

do $$ begin
  if exists (
    select 1 from auth.users
    where id in (
      '91111111-1111-4111-8111-111111111111',
      '92222222-2222-4222-8222-222222222222'
    )
  ) then
    raise exception 'Test fixture already exists; refusing to reuse it';
  end if;
end $$;

insert into auth.users (id, email) values
('91111111-1111-4111-8111-111111111111', 'gmail-fixture-a@ordia.test'),
('92222222-2222-4222-8222-222222222222', 'gmail-fixture-b@ordia.test');

-- -------------------------------------------------------------------------
-- 1. USUARIO A: Privilegios mínimos, bloqueo de escrituras directas y alias
-- -------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '91111111-1111-4111-8111-111111111111';

do $$
declare
  acc_a uuid := '9a000000-0000-4000-8000-000000000001';
  cat_exp_a uuid := '9a000000-0000-4000-8000-000000000010';
  alias_a1 public.bank_email_aliases;
  sub_a public.push_subscriptions;
begin
  insert into public.financial_accounts (id, user_id, name, account_type, currency, initial_balance)
  values (acc_a, '91111111-1111-4111-8111-111111111111', 'Ahorros A 8422', 'bank', 'COP', 1000000);

  insert into public.financial_categories (id, user_id, kind, name)
  values (cat_exp_a, '91111111-1111-4111-8111-111111111111', 'expense', 'Hogar A');

  insert into public.financial_transactions (
    id, user_id, kind, account_id, amount, occurred_on, category_id, description, client_request_id
  ) values (
    '9a000000-0000-4000-8000-000000000030',
    '91111111-1111-4111-8111-111111111111',
    'expense',
    acc_a,
    50000,
    '2026-10-15',
    cat_exp_a,
    'Gasto previo A',
    '9a000000-0000-4000-8000-000000000031'
  );

  -- Crear un gasto fijo y su período pendiente mediante la RPC oficial para probar independencia del canal de recordatorios
  perform public.create_fixed_expense(
    '9a000000-0000-4000-8000-000000000022',
    'Internet A',
    120000,
    cat_exp_a,
    acc_a,
    'monthly',
    '2026-11-02',
    null
  );

  -- Intento de escritura directa con marca de flujo activada manualmente bajo ROLE authenticated -> DEBE FALLAR (42501)
  perform set_config('ordia.bank_email_flow', 'on', true);
  begin
    insert into public.bank_email_aliases (user_id, alias_local_part, status, is_current)
    values ('91111111-1111-4111-8111-111111111111', 'bnc_00000000000000000000000000000001', 'pending_confirmation', true);
    raise exception 'Fallo de seguridad: authenticated pudo insertar directamente en bank_email_aliases';
  exception when insufficient_privilege then
    null;
  end;

  -- Intento de ejecutar RPC exclusiva de servidor (service_role) -> DEBE FALLAR (42501)
  begin
    perform public.ingest_bank_inbound_notification(
      repeat('a', 64),
      'bnc_00000000000000000000000000000001',
      repeat('b', 64),
      'Bancolombia',
      'purchase',
      39900,
      '2026-10-17',
      '13:17',
      'HOMECENTER RIONEGRO',
      null,
      '0541',
      'debit',
      null,
      null
    );
    raise exception 'Fallo de seguridad: authenticated pudo invocar ingest_bank_inbound_notification';
  exception when insufficient_privilege then
    null;
  end;

  -- Generar alias privado de Usuario A
  alias_a1 := public.ensure_or_replace_bank_email_alias(false);
  if alias_a1.status <> 'pending_confirmation' or alias_a1.alias_local_part !~ '^bnc_[a-f0-9]{32}$' then
    raise exception 'Alias inicial de A inválido';
  end if;

  -- Confirmar antes de que llegue el correo de verificación de Gmail -> DEBE FALLAR (23514)
  begin
    perform public.confirm_bank_email_alias(alias_a1.id);
    raise exception 'No debe permitir confirmar antes de recibir la verificación de Gmail';
  exception when check_violation then
    null;
  end;

  -- Registrar dispositivo de Usuario A con gastos fijos activos y activar también movimientos bancarios
  sub_a := public.register_push_subscription(
    'https://web.push.apple.com/device-user-a',
    'p256dh-user-a-valid-key',
    'auth-user-a-valid-key',
    'iPhone de Usuario A',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'
  );
  if not sub_a.active or not sub_a.notify_fixed_expenses or sub_a.notify_bank_movements then
    raise exception 'Estado inicial inesperado en suscripción push de A';
  end if;

  sub_a := public.set_push_channel_preference(sub_a.id, 'bank_movements', true);
  if not sub_a.active or not sub_a.notify_fixed_expenses or not sub_a.notify_bank_movements then
    raise exception 'No quedaron ambos canales activos en suscripción push de A';
  end if;
end $$;

-- -------------------------------------------------------------------------
-- 2. USUARIO B: Alias propio, suscripción push propia y aislamiento frente a A
-- -------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '92222222-2222-4222-8222-222222222222';

do $$
declare
  alias_b1 public.bank_email_aliases;
  sub_b public.push_subscriptions;
  visible_aliases integer;
begin
  alias_b1 := public.ensure_or_replace_bank_email_alias(false);
  if alias_b1.status <> 'pending_confirmation' then
    raise exception 'Alias inicial de B inválido';
  end if;

  -- B solo puede ver su propio alias (1 fila), jamás el de A
  select count(*) into visible_aliases from public.bank_email_aliases;
  if visible_aliases <> 1 then
    raise exception 'Fuga RLS en bank_email_aliases: B vio % filas', visible_aliases;
  end if;

  -- Registrar dispositivo de B solo para avisos bancarios
  sub_b := public.register_push_subscription_for_channel(
    'https://fcm.googleapis.com/fcm/send/device-user-b',
    'p256dh-user-b-valid-key',
    'auth-user-b-valid-key',
    'Android de Usuario B',
    'bank_movements',
    'Mozilla/5.0 (Linux; Android 15)'
  );
  if not sub_b.active or sub_b.notify_fixed_expenses or not sub_b.notify_bank_movements then
    raise exception 'Estado inicial inesperado en suscripción push de B';
  end if;
end $$;

-- -------------------------------------------------------------------------
-- 3. SERVICE_ROLE: Confirmación de Gmail para A sin crear movimientos ni exponer a B
-- -------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claim.sub = '';

do $$
declare
  alias_a1_row public.bank_email_aliases;
  confirm_res jsonb;
  notif_count integer;
begin
  select * into alias_a1_row
  from public.bank_email_aliases
  where user_id = '91111111-1111-4111-8111-111111111111' and is_current;

  confirm_res := public.record_bank_email_gmail_confirmation(
    repeat('1', 64),
    alias_a1_row.alias_local_part,
    repeat('2', 64),
    '847291034',
    'https://isolated.mail.google.com/mail/vf-confirm-user-a'
  );

  if confirm_res->>'outcome' <> 'recorded' or (confirm_res->>'updated')::boolean is not true then
    raise exception 'Resultado inesperado al registrar confirmación Gmail de A: %', confirm_res;
  end if;

  -- La confirmación de Gmail NUNCA debe crear filas en bank_notifications
  select count(*) into notif_count
  from public.bank_notifications
  where user_id = '91111111-1111-4111-8111-111111111111';

  if notif_count <> 0 then
    raise exception 'La confirmación de Gmail creó erróneamente movimientos bancarios';
  end if;
end $$;

-- Verificar que Usuario B NO puede leer el código/enlace de confirmación de A ni confirmar/desactivar su alias
set local role authenticated;
set local request.jwt.claim.sub = '92222222-2222-4222-8222-222222222222';

do $$
declare
  leaked_codes integer;
begin
  select count(*) into leaked_codes
  from public.bank_email_aliases
  where confirmation_code is not null or confirmation_url is not null;

  if leaked_codes <> 0 then
    raise exception 'Fuga crítica: Usuario B pudo ver código o enlace de confirmación de A';
  end if;
end $$;

-- Usuario A confirma su dirección, luego la reemplaza; Usuario B desactiva la suya y crea otra
set local role authenticated;
set local request.jwt.claim.sub = '91111111-1111-4111-8111-111111111111';

do $$
declare
  alias_a1_row public.bank_email_aliases;
  confirmed_a1 public.bank_email_aliases;
  alias_a2 public.bank_email_aliases;
begin
  select * into alias_a1_row from public.bank_email_aliases where is_current;
  if alias_a1_row.confirmation_code <> '847291034' then
    raise exception 'Usuario A no recibió su código de confirmación de Gmail';
  end if;

  confirmed_a1 := public.confirm_bank_email_alias(alias_a1_row.id);
  -- Debe distinguir dirección confirmada (confirmed_at != null) de primer aviso recibido (first_notification_at is null)
  if confirmed_a1.status <> 'active'
    or confirmed_a1.confirmed_at is null
    or confirmed_a1.first_notification_at is not null
    or confirmed_a1.confirmation_code is not null
    or confirmed_a1.confirmation_url is not null
  then
    raise exception 'Estado inválido tras confirmar alias de A: %', row_to_json(confirmed_a1);
  end if;

  -- Reemplazar dirección de A: la anterior debe quedar desactivada e inactiva de inmediato
  alias_a2 := public.ensure_or_replace_bank_email_alias(true);
  if alias_a2.id = alias_a1_row.id or alias_a2.alias_local_part = alias_a1_row.alias_local_part then
    raise exception 'El reemplazo de alias de A no generó una dirección distinta';
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '92222222-2222-4222-8222-222222222222';

do $$
declare
  alias_b1_row public.bank_email_aliases;
  disabled_b1 public.bank_email_aliases;
  alias_b2 public.bank_email_aliases;
begin
  select * into alias_b1_row from public.bank_email_aliases where is_current;
  disabled_b1 := public.disable_bank_email_alias(alias_b1_row.id);
  if disabled_b1.status <> 'disabled' or disabled_b1.disabled_reason <> 'user' then
    raise exception 'No se desactivó correctamente el alias de B';
  end if;

  -- Generar nueva dirección activa/pendiente para B dejando la anterior desactivada
  alias_b2 := public.ensure_or_replace_bank_email_alias(true);
  if alias_b2.id = alias_b1_row.id then
    raise exception 'No se generó un nuevo alias tras desactivar el anterior de B';
  end if;
end $$;

-- -------------------------------------------------------------------------
-- 4. SERVICE_ROLE: Rechazo de alias desactivados/reemplazados, los 3 ejemplos
--    de Bancolombia (22000, 39900, 200000), duplicados vs dos compras similares,
--    saldo intacto y aislamiento Web Push entre A y B
-- -------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claim.sub = '';

do $$
declare
  old_alias_a text;
  cur_alias_a text;
  old_alias_b text;
  cur_alias_b text;
  res jsonb;
  notif_ex1_id uuid;
  notif_ex2_id uuid;
  notif_ex2_similar_id uuid;
  notif_ex3_b_id uuid;
  tx_count_a integer;
  net_balance_a bigint;
  sub_a_id uuid;
  sub_b_id uuid;
  run_id uuid := gen_random_uuid();
  attempt_cross uuid;
  attempt_a1 uuid;
  attempt_dup uuid;
begin
  select alias_local_part into old_alias_a
  from public.bank_email_aliases
  where user_id = '91111111-1111-4111-8111-111111111111' and not is_current;

  select alias_local_part into cur_alias_a
  from public.bank_email_aliases
  where user_id = '91111111-1111-4111-8111-111111111111' and is_current;

  select alias_local_part into old_alias_b
  from public.bank_email_aliases
  where user_id = '92222222-2222-4222-8222-222222222222' and not is_current;

  select alias_local_part into cur_alias_b
  from public.bank_email_aliases
  where user_id = '92222222-2222-4222-8222-222222222222' and is_current;

  -- A) Correo dirigido al alias REEMPLAZADO de A -> rechazado (alias_inactive)
  res := public.ingest_bank_inbound_notification(
    repeat('3', 64), old_alias_a, repeat('4', 64),
    'Bancolombia', 'transfer_received', 22000, '2026-10-31', '13:28',
    null, '8422', null, null, null, null
  );
  if res->>'outcome' <> 'alias_inactive' or (res->>'is_new_notification')::boolean then
    raise exception 'El alias reemplazado de A aceptó un aviso indebidamente: %', res;
  end if;

  -- B) Correo dirigido al alias DESACTIVADO de B -> rechazado (alias_inactive)
  res := public.ingest_bank_inbound_notification(
    repeat('5', 64), old_alias_b, repeat('6', 64),
    'Bancolombia', 'purchase', 39900, '2026-10-17', '13:17',
    'HOMECENTER RIONEGRO', null, '0541', 'debit', null, null
  );
  if res->>'outcome' <> 'alias_inactive' or (res->>'is_new_notification')::boolean then
    raise exception 'El alias desactivado de B aceptó un aviso indebidamente: %', res;
  end if;

  -- C) Ejemplo 1 ($22,000 -> 22000 COP) en alias vigente de A
  res := public.ingest_bank_inbound_notification(
    'a1' || repeat('0', 62), cur_alias_a, 'b1' || repeat('0', 62),
    'Bancolombia', 'transfer_received', 22000, '2026-10-31', '13:28',
    null, '8422', null, null, null, null
  );
  if res->>'outcome' <> 'created' or (res->>'is_new_notification')::boolean is not true then
    raise exception 'Fallo al crear Ejemplo 1 para A: %', res;
  end if;
  notif_ex1_id := (res->>'notification_id')::uuid;

  -- D) Ejemplo 2 ($39.900,00 -> 39900 COP) en alias vigente de A
  res := public.ingest_bank_inbound_notification(
    'a2' || repeat('0', 62), cur_alias_a, 'b2' || repeat('0', 62),
    'Bancolombia', 'purchase', 39900, '2026-10-17', '13:17',
    'HOMECENTER RIONEGRO', null, '0541', 'debit', null, null
  );
  if res->>'outcome' <> 'created' or (res->>'is_new_notification')::boolean is not true then
    raise exception 'Fallo al crear Ejemplo 2 para A: %', res;
  end if;
  notif_ex2_id := (res->>'notification_id')::uuid;

  -- E) Reintento duplicado del mismo correo (mismo provider_event_hash o mismo message_id_hash) -> NO duplica
  res := public.ingest_bank_inbound_notification(
    'a2' || repeat('0', 62), cur_alias_a, 'b2' || repeat('0', 62),
    'Bancolombia', 'purchase', 39900, '2026-10-17', '13:17',
    'HOMECENTER RIONEGRO', null, '0541', 'debit', null, null
  );
  if res->>'outcome' <> 'duplicate' or (res->>'is_new_notification')::boolean then
    raise exception 'El reintento con mismo provider_event_hash no se detectó como duplicado: %', res;
  end if;

  res := public.ingest_bank_inbound_notification(
    'a9' || repeat('0', 62), cur_alias_a, 'b2' || repeat('0', 62),
    'Bancolombia', 'purchase', 39900, '2026-10-17', '13:17',
    'HOMECENTER RIONEGRO', null, '0541', 'debit', null, null
  );
  if res->>'outcome' <> 'duplicate' or (res->>'is_new_notification')::boolean then
    raise exception 'El reintento con mismo message_id_hash no se detectó como duplicado: %', res;
  end if;

  -- F) Segunda operación legítima que coincide en monto (39900), comercio y minuto (13:17) con otro Message-ID -> SÍ se crea
  res := public.ingest_bank_inbound_notification(
    'a3' || repeat('0', 62), cur_alias_a, 'b3' || repeat('0', 62),
    'Bancolombia', 'purchase', 39900, '2026-10-17', '13:17',
    'HOMECENTER RIONEGRO', null, '0541', 'debit', null, null
  );
  if res->>'outcome' <> 'created' or (res->>'is_new_notification')::boolean is not true then
    raise exception 'Se descartó erróneamente una segunda operación legítima similar: %', res;
  end if;
  notif_ex2_similar_id := (res->>'notification_id')::uuid;
  if notif_ex2_similar_id = notif_ex2_id then
    raise exception 'Las dos operaciones similares devolvieron el mismo ID';
  end if;

  -- G) Ejemplo 3 ($200,000.00 -> 200000 COP) en alias vigente de Usuario B
  res := public.ingest_bank_inbound_notification(
    'a4' || repeat('0', 62), cur_alias_b, 'b4' || repeat('0', 62),
    'Bancolombia', 'transfer_sent', 200000, '2026-10-20', '21:15',
    null, '8422', null, null, null, null
  );
  if res->>'outcome' <> 'created' or res->>'user_id' <> '92222222-2222-4222-8222-222222222222' then
    raise exception 'Fallo al crear Ejemplo 3 para B: %', res;
  end if;
  notif_ex3_b_id := (res->>'notification_id')::uuid;

  -- H) Comprobar que recibir correos NO altera saldos ni crea movimientos financieros
  select count(*) into tx_count_a
  from public.financial_transactions
  where user_id = '91111111-1111-4111-8111-111111111111' and deleted_at is null;

  select a.initial_balance - coalesce(sum(t.amount), 0) into net_balance_a
  from public.financial_accounts a
  left join public.financial_transactions t on t.account_id = a.id and t.deleted_at is null
  where a.id = '9a000000-0000-4000-8000-000000000001'
  group by a.id, a.initial_balance;

  if tx_count_a <> 1 or net_balance_a <> 950000 then
    raise exception 'Recibir correos alteró movimientos (%) o saldo (%) de A', tx_count_a, net_balance_a;
  end if;

  -- I) Comprobar aislamiento Web Push: el dispositivo de B JAMÁS puede reclamar un aviso de A
  select id into sub_a_id from public.push_subscriptions where user_id = '91111111-1111-4111-8111-111111111111';
  select id into sub_b_id from public.push_subscriptions where user_id = '92222222-2222-4222-8222-222222222222';

  attempt_cross := public.claim_bank_push_notification_attempt(sub_b_id, notif_ex1_id, run_id);
  if attempt_cross is not null then
    raise exception 'Fuga crítica: el dispositivo de B pudo reclamar un push del aviso bancario de A';
  end if;

  -- El dispositivo de A reclama y completa su aviso notif_ex1_id exactamente una vez
  attempt_a1 := public.claim_bank_push_notification_attempt(sub_a_id, notif_ex1_id, run_id);
  if attempt_a1 is null then
    raise exception 'El dispositivo habilitado de A no pudo reclamar su propio aviso bancario';
  end if;

  if not public.is_bank_push_notification_attempt_deliverable(attempt_a1, run_id) then
    raise exception 'El intento push de A debía ser entregable';
  end if;

  perform public.complete_bank_push_notification_attempt(attempt_a1, run_id, 'sent', null, null);

  -- Un segundo intento para el mismo (sub_a_id, notif_ex1_id) ya enviado devuelve NULL (idempotente)
  attempt_dup := public.claim_bank_push_notification_attempt(sub_a_id, notif_ex1_id, gen_random_uuid());
  if attempt_dup is not null then
    raise exception 'Se permitió duplicar el envío push para el mismo aviso bancario';
  end if;
end $$;

-- -------------------------------------------------------------------------
-- 5. Verificar aislamiento RLS cruzado de pendientes y que desactivar avisos
--    bancarios NO desactiva los recordatorios de gastos fijos
-- -------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claim.sub = '91111111-1111-4111-8111-111111111111';

do $$
declare
  count_a integer;
  sub_a public.push_subscriptions;
  updated_sub_a public.push_subscriptions;
begin
  -- Usuario A debe ver exactamente sus 3 avisos (22000, 39900 y 39900 similar) y NUNCA el de 200000 de B
  select count(*) into count_a from public.bank_notifications;
  if count_a <> 3 then
    raise exception 'Usuario A debía ver 3 avisos propios y vio %', count_a;
  end if;

  if exists (select 1 from public.bank_notifications where amount = 200000) then
    raise exception 'Fuga RLS: Usuario A vio el aviso de 200000 perteneciente a B';
  end if;

  -- Usuario A desactiva «Avisarme de movimientos bancarios»
  select * into sub_a from public.push_subscriptions where active;
  updated_sub_a := public.set_push_channel_preference(sub_a.id, 'bank_movements', false);

  if not updated_sub_a.active
    or not updated_sub_a.notify_fixed_expenses
    or updated_sub_a.notify_bank_movements
  then
    raise exception 'Desactivar avisos bancarios alteró los recordatorios de gastos fijos: %', row_to_json(updated_sub_a);
  end if;
end $$;

set local role service_role;
set local request.jwt.claim.sub = '';

do $$
declare
  sub_a_id uuid;
  notif_a2_id uuid;
  period_a_id uuid;
  bank_attempt_after_off uuid;
  fixed_attempt_id uuid;
  fixed_run_id uuid := gen_random_uuid();
begin
  select id into sub_a_id from public.push_subscriptions where user_id = '91111111-1111-4111-8111-111111111111';
  select id into notif_a2_id
  from public.bank_notifications
  where user_id = '91111111-1111-4111-8111-111111111111' and amount = 39900
  limit 1;
  select id into period_a_id
  from public.fixed_expense_periods
  where user_id = '91111111-1111-4111-8111-111111111111' and due_date = '2026-11-02'
  limit 1;

  if period_a_id is null then
    raise exception 'No se generó el período pendiente de gasto fijo esperado';
  end if;

  -- Con notify_bank_movements = false, ya NO se reclama push bancario
  bank_attempt_after_off := public.claim_bank_push_notification_attempt(sub_a_id, notif_a2_id, gen_random_uuid());
  if bank_attempt_after_off is not null then
    raise exception 'Se reclamó push bancario pese a tener notify_bank_movements = false';
  end if;

  -- En cambio, el recordatorio de gastos fijos SÍ sigue funcionando normalmente en ese mismo dispositivo
  fixed_attempt_id := public.claim_push_notification_attempt(
    sub_a_id,
    period_a_id,
    '2026-11-02',
    'due_today',
    fixed_run_id
  );
  if fixed_attempt_id is null or not public.is_push_notification_attempt_deliverable(fixed_attempt_id, fixed_run_id) then
    raise exception 'Desactivar avisos bancarios impidió reclamar recordatorios de gastos fijos';
  end if;
end $$;

rollback;
