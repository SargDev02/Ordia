-- Pruebas SECUENCIALES de vencimiento y límites de la advertencia externa.
-- Sin concurrencia: fixtures exclusivos, llamadas como authenticated y ROLLBACK.
-- Ejecutar solo tras verificar que el destino es Ordia o una base local de pruebas.
begin;
set local statement_timeout = '30s';
do $$ begin
  if exists(select 1 from auth.users where id in
    ('75555555-5555-4555-8555-555555555555','76666666-6666-4666-8666-666666666666')) then
    raise exception 'Fixture ocupado; no reutilizar datos existentes';
  end if;
end $$;
insert into auth.users(id,email) values
  ('75555555-5555-4555-8555-555555555555','planner-guards-a@ordia.test'),
  ('76666666-6666-4666-8666-666666666666','planner-guards-b@ordia.test');

-- Solo la preparación privilegiada simula la caché del servidor; nunca llama a proveedores.
do $$
declare
  u uuid := '75555555-5555-4555-8555-555555555555';
  d date := (now() at time zone 'America/Bogota')::date + 2;
  gc public.google_connections; gw public.google_windows; gcal uuid;
  ic public.icloud_connections; iw public.icloud_windows; ical uuid;
begin
  insert into public.google_connections(user_id,status) values(u,'connected') returning * into gc;
  insert into public.google_calendars(connection_id,user_id,name,selected)
    values(gc.id,u,'Fixture Google',true) returning id into gcal;
  insert into public.google_windows(connection_id,user_id,generation,start_on,end_on,synced_at)
    values(gc.id,u,gc.generation,d,d+7,now()-interval '2 days') returning * into gw;
  insert into public.google_events(window_id,calendar_id,user_id,occurrence_key,provider_event_id,title,all_day,starts_at,ends_at)
    values(gw.id,gcal,u,'timed','timed','Fixture Google conocido',false,
      (d+time '14:00') at time zone 'America/Bogota',(d+time '15:00') at time zone 'America/Bogota');
  insert into public.icloud_connections(user_id,status) values(u,'reconnect') returning * into ic;
  insert into public.icloud_calendars(connection_id,user_id,name,selected)
    values(ic.id,u,'Fixture iCloud',true) returning id into ical;
  insert into public.icloud_windows(connection_id,user_id,generation,start_on,end_on,synced_at)
    values(ic.id,u,ic.generation,d,d+7,now()-interval '2 days') returning * into iw;
  insert into public.icloud_events(window_id,calendar_id,user_id,occurrence_key,title,all_day,starts_at,ends_at)
    values(iw.id,ical,u,'timed','Fixture iCloud conocido',false,
      (d+time '16:00') at time zone 'America/Bogota',(d+time '17:00') at time zone 'America/Bogota');
  insert into public.icloud_events(window_id,calendar_id,user_id,occurrence_key,title,all_day,start_on,end_on)
    values(iw.id,ical,u,'all-day','Fixture día completo',true,d+1,d+2);
end $$;

-- Ayuda temporal invocadora: comprueba código Y mensaje; una excepción inesperada falla.
create function pg_temp.expect_schedule_error(t uuid, at_time timestamptz, expected_state text,
  expected_message text, accept_unverified boolean default true) returns void
language plpgsql security invoker as $$
declare v timestamptz; actual_state text; actual_message text;
begin
  select updated_at into v from public.personal_tasks where id=t;
  begin
    perform public.schedule_personal_task(t,at_time,v,60,accept_unverified);
  exception when others then
    get stacked diagnostics actual_state=returned_sqlstate, actual_message=message_text;
  end;
  if actual_state is distinct from expected_state or actual_message is distinct from expected_message then
    raise exception 'Esperado % / %, recibido % / %',expected_state,expected_message,actual_state,actual_message;
  end if;
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '75555555-5555-4555-8555-555555555555';
insert into public.task_scheduling_preferences(buffer_minutes,all_day_blocks,slots)
  select 15,true,jsonb_agg(jsonb_build_object('day_of_week',d,'start_time','09:00','end_time','18:00'))
  from generate_series(1,7) d;
do $$
declare
  today date := (now() at time zone 'America/Bogota')::date;
  d date := today+2;
  at_time timestamptz := ((today+2)+time '10:00') at time zone 'America/Bogota';
  t public.personal_tasks; blocker public.personal_tasks; other public.personal_tasks;
begin
  t := public.create_personal_task(gen_random_uuid(),'Fixture vencimiento',null,'medium',60,today-1,null);
  -- Vencida: futura reprogramación tardía, conserva exactamente el vencimiento original.
  t := public.schedule_personal_task(t.id,at_time,t.updated_at,60,true);
  if t.due_on <> today-1 or t.scheduled_at <> at_time then raise exception 'Reprogramación tardía inconsistente'; end if;
  update public.personal_tasks set scheduled_at=null,due_on=today where id=t.id;
  perform pg_temp.expect_schedule_error(t.id,at_time,'22023','after_due_date');
  update public.personal_tasks set due_on=d where id=t.id returning * into t;
  t := public.schedule_personal_task(t.id,(d+time '12:00') at time zone 'America/Bogota',t.updated_at,60,true);
  if t.due_on <> d then raise exception 'Se alteró due_on vigente'; end if;
  update public.personal_tasks set scheduled_at=null where id=t.id;
  perform pg_temp.expect_schedule_error(t.id,((d+2)+time '10:00') at time zone 'America/Bogota','22023','after_due_date');
  update public.personal_tasks set due_on=null where id=t.id;

  -- Misma propuesta libre: sin aceptación falla por caché vieja; con ella pasa.
  perform pg_temp.expect_schedule_error(t.id,at_time,'55000','calendar_unverified',false);
  select * into t from public.personal_tasks where id=t.id;
  t := public.schedule_personal_task(t.id,at_time,t.updated_at,60,true);
  update public.personal_tasks set scheduled_at=null where id=t.id;
  -- Incluso aceptando: sin cobertura (fuera de ventana) solo se omite esa comprobación.
  select * into t from public.personal_tasks where id=t.id;
  t := public.schedule_personal_task(t.id,((d+8)+time '10:00') at time zone 'America/Bogota',t.updated_at,60,true);
  update public.personal_tasks set scheduled_at=null where id=t.id;
  perform pg_temp.expect_schedule_error(t.id,((d+8)+time '10:00') at time zone 'America/Bogota','55000','calendar_unverified',false);

  -- La aceptación nunca omite disponibilidad, pasado, duración ni estado.
  perform pg_temp.expect_schedule_error(t.id,(d+time '20:00') at time zone 'America/Bogota','22023','outside_availability');
  perform pg_temp.expect_schedule_error(t.id,now()-interval '1 minute','22023','schedule_in_past');
  select * into t from public.personal_tasks where id=t.id;
  begin
    perform public.schedule_personal_task(t.id,at_time,t.updated_at,0,true);
    raise exception 'Duración cero aceptada';
  exception when sqlstate '22023' then
    if sqlerrm <> 'duration_required' then raise; end if;
  end;
  update public.task_scheduling_preferences set slots='[]';
  perform pg_temp.expect_schedule_error(t.id,at_time,'22023','availability_required');
  update public.task_scheduling_preferences set slots=(select jsonb_agg(jsonb_build_object(
    'day_of_week',day,'start_time','09:00','end_time','18:00')) from generate_series(1,7) day);
  update public.personal_tasks set is_completed=true where id=t.id;
  perform pg_temp.expect_schedule_error(t.id,at_time,'22023','task_completed');
  update public.personal_tasks set is_completed=false where id=t.id;
  select * into t from public.personal_tasks where id=t.id;
  begin
    perform public.schedule_personal_task(t.id,at_time,t.updated_at-interval '1 second',60,true);
    raise exception 'Versión antigua aceptada';
  exception when sqlstate '40001' then
    if sqlerrm <> 'task_modified' then raise; end if;
  end;

  -- Conflictos propios y margen de 15 min siguen vigentes con aceptación.
  blocker := public.create_personal_task(gen_random_uuid(),'Fixture bloqueante',null,'medium',60,null,at_time);
  perform pg_temp.expect_schedule_error(t.id,at_time+interval '30 minutes','23P01','task_schedule_overlap');
  perform pg_temp.expect_schedule_error(t.id,at_time+interval '70 minutes','23P01','task_schedule_overlap');
  update public.personal_tasks set scheduled_at=null where id=blocker.id;
  -- Conflictos externos conocidos siguen vigentes aun con caché vieja / reconexión.
  perform pg_temp.expect_schedule_error(t.id,(d+time '14:15') at time zone 'America/Bogota','23P01','calendar_event_conflict');
  perform pg_temp.expect_schedule_error(t.id,(d+time '13:05') at time zone 'America/Bogota','23P01','calendar_event_conflict');
  perform pg_temp.expect_schedule_error(t.id,(d+time '16:15') at time zone 'America/Bogota','23P01','calendar_event_conflict');
  perform pg_temp.expect_schedule_error(t.id,((d+1)+time '10:00') at time zone 'America/Bogota','23P01','calendar_event_conflict');
  -- No se filtran ni se programan tareas del usuario A al cambiar la identidad a B.
  perform set_config('request.jwt.claim.sub','76666666-6666-4666-8666-666666666666',true);
  perform pg_temp.expect_schedule_error(t.id,at_time,'P0002','task_not_found');
  if exists(select 1 from public.personal_tasks where id=t.id) then raise exception 'RLS permitió leer tarea ajena'; end if;
  other := public.create_personal_task(gen_random_uuid(),'Fixture usuario B',null,'medium',60,null,null);
  begin
    update public.personal_tasks set user_id='75555555-5555-4555-8555-555555555555' where id=other.id;
    raise exception 'Se permitió cambiar propietario';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select 'PASS: pruebas SECUENCIALES de vencimientos, aceptación limitada, conflictos conocidos y propiedad (authenticated, no sesiones Auth reales).' as result;
rollback;
select 'PASS: sequential guards, overdue reschedule, limited override, ownership' as result,
  count(*)::integer as fixture_users_remaining from auth.users where id in
  ('75555555-5555-4555-8555-555555555555','76666666-6666-4666-8666-666666666666');
