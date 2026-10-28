-- Fixtures reservados, sin solicitudes a Google, sin datos reales y con ROLLBACK obligatorio.
begin;
do $$ begin
  if exists(select 1 from auth.users where id in ('91111111-1111-4111-8111-111111111111','92222222-2222-4222-8222-222222222222')) then raise exception 'Fixtures already exist'; end if;
end $$;
insert into auth.users(id,email) values ('91111111-1111-4111-8111-111111111111','google-fixture-a@ordia.test'),('92222222-2222-4222-8222-222222222222','google-fixture-b@ordia.test');
set local role service_role;
do $$ declare owner_id uuid; h text; op jsonb; conn public.google_connections; cal uuid; payload jsonb;
begin
  foreach owner_id in array array['91111111-1111-4111-8111-111111111111'::uuid,'92222222-2222-4222-8222-222222222222'::uuid] loop
    h:=encode(sha256(owner_id::text::bytea),'hex');
    perform public.create_google_oauth_state(owner_id,h,'fixture-encrypted-verifier','http://localhost:5173');
    begin perform public.consume_google_oauth(h,repeat('b',64)); raise exception 'TEST FAILED: created state consumed';
      exception when raise_exception then if SQLERRM<>'oauth_state_invalid' then raise; end if; end;
    begin perform public.activate_google_oauth(h,'https://foreign.test',repeat('b',64)); raise exception 'TEST FAILED: foreign origin accepted';
      exception when raise_exception then if SQLERRM<>'oauth_state_invalid' then raise; end if; end;
    update private.google_oauth_states set expires_at=now()-interval '1 second' where state_hash=h;
    begin perform public.activate_google_oauth(h,'http://localhost:5173',repeat('b',64)); raise exception 'TEST FAILED: expired state activated';
      exception when raise_exception then if SQLERRM<>'oauth_state_invalid' then raise; end if; end;
    update private.google_oauth_states set expires_at=now()+interval '10 minutes' where state_hash=h;
    perform public.activate_google_oauth(h,'http://localhost:5173',repeat('b',64));
    begin perform public.consume_google_oauth(h,repeat('c',64)); raise exception 'TEST FAILED: wrong browser accepted';
      exception when raise_exception then if SQLERRM<>'oauth_state_invalid' then raise; end if; end;
    perform public.consume_google_oauth(h,repeat('b',64));
    begin perform public.consume_google_oauth(h,repeat('b',64)); raise exception 'TEST FAILED: state reused';
      exception when raise_exception then if SQLERRM<>'oauth_state_invalid' then raise; end if; end;
    perform public.finish_google_oauth(h,'fixture-encrypted-tokens','[{"remote_id":"private-id","name":"Fixture","color":"#123456"}]');
    begin perform public.finish_google_oauth(h,'fixture-ciphertext','[]'); raise exception 'TEST FAILED: OAuth committed twice';
      exception when raise_exception then if SQLERRM<>'oauth_state_invalid' then raise; end if; end;
  end loop;
  select * into strict conn from public.google_connections where user_id='91111111-1111-4111-8111-111111111111';
  select id into strict cal from public.google_calendars where connection_id=conn.id;
  op:=public.begin_google_operation(conn.user_id,'select','2026-10-26');
  perform public.finish_google_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'select',jsonb_build_object('ids',jsonb_build_array(cal)));
  select * into conn from public.google_connections where id=conn.id;
  payload:=jsonb_build_object('start_on','2026-10-26','events',jsonb_build_array(jsonb_build_object(
    'calendar_id',cal,'occurrence_key','stable-one','provider_event_id','instance-1','original_start',jsonb_build_object('date','2026-10-27'),'original_end',jsonb_build_object('date','2026-10-28'),
    'title','Fixture A','description','','location','','url',null,'all_day',true,'starts_at',null,'ends_at',null,'start_on','2026-10-27','end_on','2026-10-28')));
  op:=public.begin_google_operation(conn.user_id,'sync','2026-10-26');
  begin perform public.begin_google_operation(conn.user_id,'sync','2026-10-26'); raise exception 'TEST FAILED: concurrent lease accepted';
    exception when raise_exception then if SQLERRM<>'sync_busy' then raise; end if; end;
  perform public.store_google_tokens(conn.user_id,(op->>'token')::uuid,conn.generation,'fixture-rotated-encrypted-tokens');
  if (select encrypted from private.google_credentials where connection_id=conn.id)<>'fixture-rotated-encrypted-tokens' then raise exception 'Refresh not persisted'; end if;
  perform public.finish_google_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync',payload);
  op:=public.begin_google_operation(conn.user_id,'sync','2026-10-26');
  perform public.finish_google_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync',payload);
  if (select count(*) from public.google_events where user_id=conn.user_id)<>1 then raise exception 'Duplicate event after resync'; end if;
  op:=public.begin_google_operation(conn.user_id,'sync','2026-10-26');
  begin perform public.finish_google_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync',jsonb_set(payload,'{events,0,calendar_id}','"00000000-0000-4000-8000-000000000000"')); raise exception 'TEST FAILED: unknown calendar accepted';
    exception when raise_exception then if SQLERRM<>'invalid_calendar' then raise; end if; end;
  if (select count(*) from public.google_events where user_id=conn.user_id)<>1 then raise exception 'Partial replacement destroyed snapshot'; end if;
  perform public.fail_google_operation(conn.user_id,(op->>'token')::uuid,'google_incomplete_response',false);
  if (select count(*) from public.google_events where user_id=conn.user_id)<>1 then raise exception 'Failed sync destroyed snapshot'; end if;
  op:=public.begin_google_operation(conn.user_id,'discover','2026-10-26');
  perform public.finish_google_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'discover','{"calendars":[{"remote_id":"private-id","name":"Fixture renombrado","color":"#654321"},{"remote_id":"new-calendar","name":"Nuevo","color":"#123456"}]}');
  if (select count(*) from public.google_events where user_id=conn.user_id)<>1 or (select count(*) from public.google_windows where connection_id=conn.id)<>1 then raise exception 'Discovery removed valid snapshot'; end if;
  if (select generation from public.google_connections where id=conn.id)<>conn.generation then raise exception 'Discovery invalidated valid snapshot'; end if;
  if not (select selected from public.google_calendars where id=cal) or (select selected from public.google_calendars where connection_id=conn.id and name='Nuevo') then raise exception 'Discovery changed selection'; end if;
  op:=public.begin_google_operation(conn.user_id,'sync','2026-10-26');
  perform public.fail_google_operation(conn.user_id,(op->>'token')::uuid,'google_unavailable',false);
  if (select count(*) from public.google_events where user_id=conn.user_id)<>1 then raise exception 'Post-discovery failure destroyed snapshot'; end if;
end $$;

-- RLS comprobada con el rol authenticated y claims A/B; no con bypass service_role.
set local role authenticated;
set local request.jwt.claim.sub='91111111-1111-4111-8111-111111111111';
do $$ begin
  if (select count(*) from public.google_connections)<>1 or (select count(*) from public.google_calendars)<>2 or (select count(*) from public.google_events)<>1 then raise exception 'A isolation failed'; end if;
  begin perform 1 from private.google_credentials; raise exception 'TEST FAILED: browser read tokens'; exception when insufficient_privilege then null; end;
  begin perform 1 from private.google_oauth_states; raise exception 'TEST FAILED: browser read OAuth verifier'; exception when insufficient_privilege then null; end;
  begin update public.google_connections set user_id='92222222-2222-4222-8222-222222222222'; raise exception 'TEST FAILED: owner changed'; exception when insufficient_privilege then null; end;
  begin delete from public.google_events; raise exception 'TEST FAILED: browser deleted cache'; exception when insufficient_privilege then null; end;
  begin perform public.disconnect_google('92222222-2222-4222-8222-222222222222'); raise exception 'TEST FAILED: browser called server RPC'; exception when insufficient_privilege then null; end;
  begin perform public.consume_google_oauth(repeat('a',64),repeat('b',64)); raise exception 'TEST FAILED: browser consumed OAuth state'; exception when insufficient_privilege then null; end;
end $$;
set local request.jwt.claim.sub='92222222-2222-4222-8222-222222222222';
do $$ begin
  if (select count(*) from public.google_connections)<>1 or (select count(*) from public.google_calendars)<>1 or (select count(*) from public.google_events)<>0 then raise exception 'B isolation failed'; end if;
end $$;
set local role anon;
do $$ begin
  begin perform 1 from public.google_connections; raise exception 'TEST FAILED: anon read connection'; exception when insufficient_privilege then null; end;
end $$;

set local role service_role;
do $$ declare conn public.google_connections; op jsonb; other_cal uuid; h text;
begin
  select * into strict conn from public.google_connections where user_id='91111111-1111-4111-8111-111111111111';
  select id into strict other_cal from public.google_calendars where user_id='92222222-2222-4222-8222-222222222222';
  op:=public.begin_google_operation(conn.user_id,'select','2026-10-26');
  begin perform public.finish_google_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'select',jsonb_build_object('ids',jsonb_build_array(other_cal))); raise exception 'TEST FAILED: foreign calendar selected';
    exception when raise_exception then if SQLERRM<>'invalid_calendar' then raise; end if; end;
  perform public.fail_google_operation(conn.user_id,(op->>'token')::uuid,'google_permission_required',true);
  if (select status from public.google_connections where id=conn.id)<>'reconnect' then raise exception 'Revoked state not marked'; end if;
  if (select count(*) from public.google_events where user_id=conn.user_id)<>1 then raise exception 'Revoked state lost last snapshot'; end if;
  update public.google_connections set status='connected' where id=conn.id;
  op:=public.begin_google_operation(conn.user_id,'sync','2026-10-26');
  perform public.finish_google_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync','{"start_on":"2026-10-26","events":[]}');
  if exists(select 1 from public.google_events where user_id=conn.user_id) then raise exception 'Authoritative empty snapshot not applied'; end if;
  h:=repeat('d',64);
  perform public.create_google_oauth_state(conn.user_id,h,'fixture-verifier','http://localhost:5173');
  perform public.activate_google_oauth(h,'http://localhost:5173',repeat('b',64));
  perform public.consume_google_oauth(h,repeat('b',64));
  op:=public.begin_google_operation(conn.user_id,'sync','2026-10-26');
  perform public.disconnect_google(conn.user_id);
  begin perform public.finish_google_operation(conn.user_id,(op->>'token')::uuid,conn.generation,'sync','{"start_on":"2026-10-26","events":[]}'); raise exception 'TEST FAILED: stale sync restored data';
    exception when raise_exception then if SQLERRM<>'operation_cancelled' then raise; end if; end;
  begin perform public.store_google_tokens(conn.user_id,(op->>'token')::uuid,conn.generation,'stale-ciphertext'); raise exception 'TEST FAILED: stale refresh restored tokens';
    exception when raise_exception then if SQLERRM<>'operation_cancelled' then raise; end if; end;
  begin perform public.finish_google_oauth(h,'stale-ciphertext','[]'); raise exception 'TEST FAILED: stale callback restored connection';
    exception when raise_exception then if SQLERRM<>'oauth_state_invalid' then raise; end if; end;
  if exists(select 1 from private.google_credentials where connection_id=conn.id) or exists(select 1 from public.google_windows where connection_id=conn.id)
    or exists(select 1 from public.google_calendars where connection_id=conn.id) or exists(select 1 from private.google_oauth_states where user_id=conn.user_id) then raise exception 'Disconnect did not remove cache/tokens/states'; end if;
  if (select status from public.google_connections where user_id='92222222-2222-4222-8222-222222222222')<>'connected' then raise exception 'A disconnected B'; end if;
end $$;
reset role;
select 'PASS: OAuth state lifecycle/browser/expiry/replay, cache idempotency/atomicity, refresh leases, stale sync/callback after disconnect, RLS authenticated A/B and permissions' as result;
rollback;
