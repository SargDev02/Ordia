-- Fixtures exclusivos y ROLLBACK. No realiza solicitudes a Apple ni modifica datos existentes.
begin;
do $$ begin
  if exists(select 1 from auth.users where id in ('81111111-1111-4111-8111-111111111111','82222222-2222-4222-8222-222222222222')) then raise exception 'Fixtures already exist'; end if;
end $$;
insert into auth.users(id,email) values ('81111111-1111-4111-8111-111111111111','icloud-fixture-a@ordia.test'),('82222222-2222-4222-8222-222222222222','icloud-fixture-b@ordia.test');
set local role service_role;
do $$ declare op jsonb; conn public.icloud_connections; cal uuid; payload jsonb;
begin
  op:=public.begin_icloud_operation('81111111-1111-4111-8111-111111111111','connect','2026-10-26');
  begin perform public.begin_icloud_operation('81111111-1111-4111-8111-111111111111','sync','2026-10-26'); raise exception 'TEST FAILED: simultaneous lease allowed'; exception when raise_exception then if SQLERRM<>'sync_busy' then raise; end if; end;
  perform public.finish_icloud_operation('81111111-1111-4111-8111-111111111111',(op->>'token')::uuid,null,'connect',
    '{"encrypted":"test-ciphertext-not-a-real-secret","calendars":[{"href":"https://p01-caldav.icloud.com/a/","name":"A privado","color":"#123456"}]}');
  select * into strict conn from public.icloud_connections where user_id='81111111-1111-4111-8111-111111111111';
  select id into strict cal from public.icloud_calendars where connection_id=conn.id;
  op:=public.begin_icloud_operation(conn.user_id,'select','2026-10-26');
  perform public.finish_icloud_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'select',jsonb_build_object('ids',jsonb_build_array(cal)));
  select * into conn from public.icloud_connections where id=conn.id;
  payload:=jsonb_build_object('start_on','2026-10-26','resources','[]'::jsonb,'events',jsonb_build_array(jsonb_build_object(
    'calendar_id',cal,'occurrence_key','stable-one','title','Fixture A','description','','location','','url',null,
    'all_day',true,'starts_at',null,'ends_at',null,'start_on','2026-10-27','end_on','2026-10-28')));
  op:=public.begin_icloud_operation(conn.user_id,'sync','2026-10-26');
  perform public.finish_icloud_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync',payload);
  op:=public.begin_icloud_operation(conn.user_id,'sync','2026-10-26');
  perform public.finish_icloud_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync',payload);
  if (select count(*) from public.icloud_events where user_id=conn.user_id)<>1 then raise exception 'Duplicate event after resync'; end if;
  -- Un commit inválido se revierte entero, incluida cualquier eliminación previa de la ventana.
  op:=public.begin_icloud_operation(conn.user_id,'sync','2026-10-26');
  begin
    perform public.finish_icloud_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync',jsonb_set(payload,'{events,0,calendar_id}','"00000000-0000-4000-8000-000000000000"'));
    raise exception 'TEST FAILED: unknown calendar allowed';
  exception when raise_exception then if SQLERRM<>'invalid_calendar' then raise; end if; end;
  if (select count(*) from public.icloud_events where user_id=conn.user_id)<>1 then raise exception 'Partial replacement removed valid copy'; end if;
  perform public.fail_icloud_operation(conn.user_id,(op->>'token')::uuid,'incomplete_response',false);
  if (select count(*) from public.icloud_events where user_id=conn.user_id)<>1 then raise exception 'Failed sync removed valid copy'; end if;
  -- Simula credencial revocada: conserva datos, exige reconexión.
  op:=public.begin_icloud_operation(conn.user_id,'sync','2026-10-26');
  perform public.fail_icloud_operation(conn.user_id,(op->>'token')::uuid,'reconnect_required',true);
  if (select status from public.icloud_connections where id=conn.id)<>'reconnect' then raise exception 'Revocation status missing'; end if;
  update public.icloud_connections set status='connected',error_code=null where id=conn.id;
  op:=public.begin_icloud_operation('82222222-2222-4222-8222-222222222222','connect','2026-10-26');
  perform public.finish_icloud_operation('82222222-2222-4222-8222-222222222222',(op->>'token')::uuid,null,'connect',
    '{"encrypted":"test-ciphertext-b","calendars":[{"href":"https://p02-caldav.icloud.com/b/","name":"B privado","color":"#654321"}]}');
end $$;

set local role authenticated;
set local request.jwt.claim.sub='81111111-1111-4111-8111-111111111111';
do $$ begin
  if (select count(*) from public.icloud_connections)<>1 or (select count(*) from public.icloud_calendars)<>1 or (select count(*) from public.icloud_events)<>1 then raise exception 'A isolation failed'; end if;
  begin perform 1 from private.icloud_credentials; raise exception 'TEST FAILED: client read credentials'; exception when insufficient_privilege then null; end;
  begin update public.icloud_connections set user_id='82222222-2222-4222-8222-222222222222'; raise exception 'TEST FAILED: client reassigned owner'; exception when insufficient_privilege then null; end;
  begin insert into public.icloud_events(window_id,calendar_id,user_id,occurrence_key,title,all_day) values(gen_random_uuid(),gen_random_uuid(),auth.uid(),'forged','forged',true); raise exception 'TEST FAILED: client inserted event'; exception when insufficient_privilege then null; end;
  begin perform public.disconnect_icloud('82222222-2222-4222-8222-222222222222'); raise exception 'TEST FAILED: client called server RPC'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub='82222222-2222-4222-8222-222222222222';
do $$ begin
  if (select count(*) from public.icloud_connections)<>1 or (select count(*) from public.icloud_events)<>0 then raise exception 'B isolation failed'; end if;
  if exists(select 1 from public.icloud_calendars where name='A privado') then raise exception 'B sees A calendar'; end if;
end $$;

set local role service_role;
do $$ declare conn public.icloud_connections; op jsonb; other_cal uuid;
begin
  select * into conn from public.icloud_connections where user_id='81111111-1111-4111-8111-111111111111';
  select id into other_cal from public.icloud_calendars where user_id='82222222-2222-4222-8222-222222222222';
  op:=public.begin_icloud_operation(conn.user_id,'select','2026-10-26');
  begin perform public.finish_icloud_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'select',jsonb_build_object('ids',jsonb_build_array(other_cal))); raise exception 'TEST FAILED: foreign calendar selected';
  exception when raise_exception then if SQLERRM<>'invalid_calendar' then raise; end if; end;
  perform public.fail_icloud_operation(conn.user_id,(op->>'token')::uuid,'invalid_calendar',false);
  -- Una respuesta completa vacía sí elimina las instancias de la ventana, de forma atómica.
  op:=public.begin_icloud_operation(conn.user_id,'sync','2026-10-26');
  perform public.finish_icloud_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync','{"start_on":"2026-10-26","resources":[],"events":[]}');
  if exists(select 1 from public.icloud_events where user_id=conn.user_id) then raise exception 'Authoritative empty snapshot did not remove events'; end if;
  -- Desconectar invalida la reserva y borra credenciales/cache; el commit antiguo no puede restaurarlos.
  op:=public.begin_icloud_operation(conn.user_id,'sync','2026-10-26');
  perform public.disconnect_icloud(conn.user_id);
  begin perform public.finish_icloud_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync','{"start_on":"2026-10-26","resources":[],"events":[]}'); raise exception 'TEST FAILED: stale sync committed';
  exception when raise_exception then if SQLERRM<>'operation_cancelled' then raise; end if; end;
  if exists(select 1 from private.icloud_credentials where connection_id=conn.id) or exists(select 1 from public.icloud_windows where connection_id=conn.id)
    or exists(select 1 from public.icloud_calendars where connection_id=conn.id) then raise exception 'Disconnect did not remove private copy'; end if;
  if (select status from public.icloud_connections where id=conn.id)<>'disconnected' then raise exception 'Disconnect status missing'; end if;
  begin perform public.finish_icloud_operation(conn.user_id,null,(select generation from public.icloud_connections where id=conn.id),'release','{}'); raise exception 'TEST FAILED: null lease accepted';
  exception when raise_exception then if SQLERRM<>'operation_cancelled' then raise; end if; end;
  update private.icloud_operations set connect_attempts=5 where user_id=conn.user_id;
  begin perform public.begin_icloud_operation(conn.user_id,'connect','2026-10-26'); raise exception 'TEST FAILED: rate limit missing';
  exception when raise_exception then if SQLERRM<>'rate_limited' then raise; end if; end;
end $$;
reset role;
select 'PASS: cache atomicity/idempotency, leases, stale commit denied after disconnect, revoked credential state, rate limits, RLS A/B, private credential permissions' as result;
rollback;
