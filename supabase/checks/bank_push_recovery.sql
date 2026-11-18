-- Local únicamente. Respuestas del proveedor simuladas, nunca envía Web Push.
begin;
insert into auth.users(id,email) values
 ('bd111111-1111-4111-8111-111111111111','push-recovery-a@ordia.test'),
 ('bd222222-2222-4222-8222-222222222222','push-recovery-b@ordia.test');
set local role authenticated;
set local request.jwt.claim.sub='bd111111-1111-4111-8111-111111111111';
select public.ensure_or_replace_bank_email_alias(false);
select public.register_push_subscription_for_channel('https://web.push.apple.com/recovery-a','p256dh-recovery-a-valid','auth-recovery-a-valid','Prueba A','bank_movements','Synthetic');
select public.register_push_subscription_for_channel('https://web.push.apple.com/recovery-a2','p256dh-recovery-a2-valid','auth-recovery-a2-valid','Prueba A2','fixed_expenses','Synthetic');
set local request.jwt.claim.sub='bd222222-2222-4222-8222-222222222222';
select public.register_push_subscription_for_channel('https://web.push.apple.com/recovery-b','p256dh-recovery-b-valid','auth-recovery-b-valid','Prueba B','bank_movements','Synthetic');
set local role service_role;
set local request.jwt.claim.sub='';
do $$
declare alias_part text;
begin
  select alias_local_part into alias_part from public.bank_email_aliases where user_id='bd111111-1111-4111-8111-111111111111';
  perform public.record_bank_email_gmail_confirmation(repeat('a',64),alias_part,repeat('b',64),'12345678',null);
end;
$$;
set local role authenticated;
set local request.jwt.claim.sub='bd111111-1111-4111-8111-111111111111';
select public.confirm_bank_email_alias((select id from public.bank_email_aliases where is_current));
set local role service_role;
set local request.jwt.claim.sub='';
do $$
declare
  alias_part text; result jsonb; duplicate jsonb; notice_id uuid;
  sub_a uuid; sub_a2 uuid; sub_b uuid; attempt_id uuid; run_id uuid := gen_random_uuid();
begin
  select alias_local_part into alias_part from public.bank_email_aliases where user_id='bd111111-1111-4111-8111-111111111111';
  select id into sub_a from public.push_subscriptions where endpoint='https://web.push.apple.com/recovery-a';
  select id into sub_a2 from public.push_subscriptions where endpoint='https://web.push.apple.com/recovery-a2';
  select id into sub_b from public.push_subscriptions where endpoint='https://web.push.apple.com/recovery-b';
  result := public.ingest_movement_notice(repeat('c',64),alias_part,repeat('d',64),'Bancolombia','purchase',3000,'2026-11-18','10:00',null,null,null,null,null,null,null);
  notice_id := (result->>'notification_id')::uuid;
  if (select count(*) from public.bank_push_notification_attempts) <> 1
    or (select status from public.bank_push_notification_attempts where bank_notification_id=notice_id) <> 'queued' then
    raise exception 'No se reservó únicamente el dispositivo habilitado al recibir';
  end if;
  if public.claim_bank_push_notification_attempt(sub_b,notice_id,run_id) is not null then raise exception 'Cruce de usuarios en push'; end if;
  attempt_id := public.claim_bank_push_notification_attempt(sub_a,notice_id,run_id);
  if attempt_id is null or public.claim_bank_push_notification_attempt(sub_a,notice_id,gen_random_uuid()) is not null then
    raise exception 'Lease ausente o duplicado';
  end if;
  perform public.complete_bank_push_notification_attempt(attempt_id,run_id,'failed',503,'provider_unavailable');
  if (select status from public.bank_notifications where id=notice_id) <> 'pending' then raise exception 'Un fallo push perdió el pendiente'; end if;
  if exists(select 1 from public.list_bank_push_retry_targets(notice_id,100)) then raise exception 'No se respetó la pausa'; end if;
  update public.bank_push_notification_attempts set attempted_at=now()-interval '2 minutes' where id=attempt_id;
  duplicate := public.ingest_movement_notice(repeat('c',64),alias_part,repeat('d',64),'Bancolombia','purchase',3000,'2026-11-18','10:00',null,null,null,null,null,null,null);
  if duplicate->>'outcome' <> 'duplicate' or (select count(*) from public.bank_notifications where user_id='bd111111-1111-4111-8111-111111111111') <> 1 then raise exception 'Reintento duplicó el aviso'; end if;
  -- Activar un segundo dispositivo después de recibir no debe producir avisos retrospectivos.
  update public.push_subscriptions set notify_bank_movements=true where id=sub_a2;
  if (select count(*) from public.list_bank_push_retry_targets(notice_id,100)) <> 1
    or public.claim_bank_push_notification_attempt(sub_a2,notice_id,run_id) is not null then
    raise exception 'Se notificó a un dispositivo no reservado al recibir';
  end if;
  attempt_id := public.claim_bank_push_notification_attempt(sub_a,notice_id,run_id);
  perform public.complete_bank_push_notification_attempt(attempt_id,run_id,'sent',null,null);
  if public.claim_bank_push_notification_attempt(sub_a,notice_id,run_id) is not null then raise exception 'Se repitió una entrega aceptada'; end if;
  -- Otra operación legítima similar sí genera otra reserva, sin unirse por importe/fecha.
  result := public.ingest_movement_notice(repeat('e',64),alias_part,repeat('f',64),'Bancolombia','purchase',3000,'2026-11-18','10:00',null,null,null,null,null,null,null);
  notice_id := (result->>'notification_id')::uuid;
  attempt_id := public.claim_bank_push_notification_attempt(sub_a,notice_id,run_id);
  perform public.complete_bank_push_notification_attempt(attempt_id,run_id,'invalid',410,'subscription_expired');
  if (select active from public.push_subscriptions where id=sub_a) then raise exception '410 no desactivó la suscripción'; end if;
  attempt_id := public.claim_bank_push_notification_attempt(sub_a2,notice_id,run_id);
  update public.push_subscriptions set notify_bank_movements=false where id=sub_a2;
  if public.is_bank_push_notification_attempt_deliverable(attempt_id,run_id) then raise exception 'No se revalidaron las preferencias'; end if;
  perform public.complete_bank_push_notification_attempt(attempt_id,run_id,'skipped',null,'state_changed');
  if not (select notify_fixed_expenses from public.push_subscriptions where id=sub_a2) then raise exception 'Se cambió el otro canal'; end if;
  -- Un lease abandonado se recupera; el proceso anterior no puede completar el nuevo.
  update public.push_subscriptions set notify_bank_movements=true where id=sub_a2;
  result := public.ingest_movement_notice(repeat('4',64),alias_part,repeat('5',64),'Bancolombia','purchase',3000,'2026-11-18','10:00',null,null,null,null,null,null,null);
  notice_id := (result->>'notification_id')::uuid;
  attempt_id := public.claim_bank_push_notification_attempt(sub_a2,notice_id,run_id);
  update public.bank_push_notification_attempts set attempted_at=now()-interval '21 minutes' where id=attempt_id;
  if public.claim_bank_push_notification_attempt(sub_a2,notice_id,'bd000000-0000-4000-8000-000000000001') is null then raise exception 'Lease abandonado no recuperado'; end if;
  begin
    perform public.complete_bank_push_notification_attempt(attempt_id,run_id,'sent',null,null);
    raise exception 'El lease anterior completó la reserva nueva';
  exception when foreign_key_violation then null; end;
  perform public.complete_bank_push_notification_attempt(attempt_id,'bd000000-0000-4000-8000-000000000001','failed',503,'provider_unavailable');
  update public.bank_push_notification_attempts set attempted_at=now()-interval '2 minutes' where id=attempt_id;
  if public.claim_bank_push_notification_attempt(sub_a2,notice_id,run_id) is null then raise exception 'Tercer intento recuperable bloqueado'; end if;
  perform public.complete_bank_push_notification_attempt(attempt_id,run_id,'failed',503,'provider_unavailable');
  update public.bank_push_notification_attempts set attempted_at=now()-interval '2 minutes' where id=attempt_id;
  if public.claim_bank_push_notification_attempt(sub_a2,notice_id,run_id) is not null then raise exception 'Se superaron tres intentos'; end if;
  perform public.record_bank_email_diagnostic(repeat('1',64),alias_part,'classification','failed_email_authentication');
  perform public.record_bank_email_diagnostic(repeat('1',64),alias_part,'classification','failed_email_authentication');
  if (select observed_count from private.bank_email_diagnostics where event_hash=repeat('1',64)) <> 2 then raise exception 'Diagnóstico duplicado incorrecto'; end if;
  begin
    perform public.record_bank_email_diagnostic(repeat('2',64),alias_part,'classification','Contenido sensible arbitrario');
    raise exception 'El diagnóstico admitió contenido libre';
  exception when check_violation then null; end;
end;
$$;
-- Un aviso reabierto al deshacer el pago no revive reservas antiguas.
set local role service_role;
do $$
declare alias_part text;
begin
  select alias_local_part into alias_part from public.bank_email_aliases where user_id='bd111111-1111-4111-8111-111111111111';
  perform public.ingest_movement_notice(repeat('6',64),alias_part,repeat('7',64),'Bancolombia','purchase',3000,'2026-11-18','10:09',null,null,null,null,null,null,null);
end;
$$;
set local role authenticated;
set local request.jwt.claim.sub='bd111111-1111-4111-8111-111111111111';
do $$
declare account_id uuid; category_id uuid; expense public.fixed_expenses; period_id uuid; notice_id uuid;
begin
  insert into public.financial_accounts(name,account_type) values('Banco de prueba','bank') returning id into account_id;
  insert into public.financial_categories(name,kind) values('Servicios de prueba','expense') returning id into category_id;
  expense := public.create_fixed_expense(gen_random_uuid(),'Servicio de prueba',5000,category_id,account_id,'monthly',(now() at time zone 'America/Bogota')::date,null);
  select id into period_id from public.fixed_expense_periods where fixed_expense_id=expense.id order by due_date limit 1;
  select id into notice_id from public.bank_notifications where occurred_time='10:09';
  perform public.pay_fixed_expense_from_bank_notice(notice_id,period_id,gen_random_uuid(),account_id,category_id,(now() at time zone 'America/Bogota')::date,3000);
  perform public.undo_fixed_expense_payment(period_id);
  if (select status from public.bank_notifications where id=notice_id) <> 'pending'
    or exists(select 1 from public.bank_push_notification_attempts where bank_notification_id=notice_id and status <> 'skipped') then
    raise exception 'Deshacer reenvió o dejó recuperables reservas antiguas';
  end if;
end;
$$;
set local role authenticated;
set local request.jwt.claim.sub='bd222222-2222-4222-8222-222222222222';
do $$
begin
  if exists(select 1 from public.bank_push_notification_attempts) then raise exception 'RLS expuso intentos ajenos'; end if;
  begin
    perform public.list_bank_push_retry_targets(null,100);
    raise exception 'authenticated pudo consultar claves de recuperación';
  exception when insufficient_privilege then null; end;
  begin
    perform public.record_bank_email_diagnostic(repeat('a',64),'no-alias','push','push_failed');
    raise exception 'authenticated pudo escribir diagnóstico del servidor';
  exception when insufficient_privilege then null; end;
end;
$$;
rollback;
