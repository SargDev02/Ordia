-- Prueba SECUENCIAL aislada de protección contra conflictos en el planificador de Ordia.
-- Una sola transacción: NO demuestra una carrera entre conexiones independientes.
-- Para concurrencia real: node scripts/check-task-scheduling-concurrency.mjs.
-- Verifica en PostgreSQL real:
-- 1. Rechazo de solapamiento entre dos tareas distintas del mismo usuario (vía RPC schedule_personal_task).
-- 2. Rechazo de solapamiento vía UPDATE manual directo (trigger de protección).
-- 3. Rechazo de solapamiento vía INSERT manual directo con horario programado.
-- 4. Validación de disponibilidad personal y margen preventivo.
-- Los vencimientos se comprueban por separado en task_scheduling_guards.sql.
-- 6. Detección de conflicto con eventos de calendarios externos sincronizados (Google/iCloud).
-- 7. Aislamiento por usuario (User B puede usar el mismo horario sin interferir con User A).
-- 8. Rollback completo para no dejar residuos.

begin;

do $$ begin
  if exists(select 1 from auth.users where id in ('73333333-3333-4333-8333-333333333333', '74444444-4444-4444-8444-444444444444')) then
    raise exception 'Test fixture already exists; refusing to reuse it';
  end if;
end $$;

insert into auth.users(id, email) values
('73333333-3333-4333-8333-333333333333', 'concurrency-a@ordia.test'),
('74444444-4444-4444-8444-444444444444', 'concurrency-b@ordia.test');

-- Crear fixture de calendario externo como service_role (simulando Edge Function de sincronización)
set local role service_role;
do $$
declare
  g_conn public.google_connections;
  g_cal public.google_calendars;
  g_win public.google_windows;
  future_monday date;
begin
  future_monday := (now() at time zone 'America/Bogota')::date + ((8 - extract(isodow from (now() at time zone 'America/Bogota'))::integer) % 7 + 7);

  insert into public.google_connections(user_id, status)
  values ('73333333-3333-4333-8333-333333333333', 'connected')
  returning * into g_conn;

  insert into public.google_calendars(connection_id, user_id, name, color, selected)
  values (g_conn.id, '73333333-3333-4333-8333-333333333333', 'Trabajo', '#315c49', true)
  returning * into g_cal;

  insert into public.google_windows(connection_id, user_id, generation, start_on, end_on, synced_at)
  values (g_conn.id, '73333333-3333-4333-8333-333333333333', g_conn.generation, future_monday, future_monday + 7, now())
  returning * into g_win;

  insert into public.google_events(
    window_id, calendar_id, user_id, occurrence_key, provider_event_id,
    title, all_day, starts_at, ends_at
  ) values (
    g_win.id, g_cal.id, '73333333-3333-4333-8333-333333333333', 'occ-ext-1', 'ext-1',
    'Reunión de equipo externa', false,
    (future_monday::text || ' 14:00:00-05')::timestamptz,
    (future_monday::text || ' 15:00:00-05')::timestamptz
  );
end $$;

-- Identidad User A
set local role authenticated;
set local request.jwt.claim.sub = '73333333-3333-4333-8333-333333333333';

-- 1. Configurar disponibilidad de User A (Lunes a Viernes 09:00 a 18:00, buffer 15 min)
insert into public.task_scheduling_preferences(user_id, buffer_minutes, all_day_blocks, slots)
values (
  '73333333-3333-4333-8333-333333333333',
  15,
  true,
  '[
    {"day_of_week": 1, "start_time": "09:00", "end_time": "18:00"},
    {"day_of_week": 2, "start_time": "09:00", "end_time": "18:00"},
    {"day_of_week": 3, "start_time": "09:00", "end_time": "18:00"},
    {"day_of_week": 4, "start_time": "09:00", "end_time": "18:00"},
    {"day_of_week": 5, "start_time": "09:00", "end_time": "18:00"}
  ]'::jsonb
);

do $$
declare
  t1 public.personal_tasks;
  t2 public.personal_tasks;
  t3 public.personal_tasks;
  scheduled_time timestamptz;
  overlapping_time timestamptz;
  future_monday date;
begin
  future_monday := (now() at time zone 'America/Bogota')::date + ((8 - extract(isodow from (now() at time zone 'America/Bogota'))::integer) % 7 + 7);
  scheduled_time := (future_monday::text || ' 10:00:00-05')::timestamptz;
  -- Intervalo que solapa con t1 (10:00 a 11:00 Bogotá, con 60 min de duración):
  -- 10:30 Bogotá entra dentro de 10:00–11:00
  overlapping_time := (future_monday::text || ' 10:30:00-05')::timestamptz;

  -- Crear Tarea 1 y Tarea 2
  t1 := public.create_personal_task('70000000-0000-4000-8000-000000000011', 'Tarea 1', null, 'high', 60, null, null);
  t2 := public.create_personal_task('70000000-0000-4000-8000-000000000012', 'Tarea 2', null, 'medium', 60, null, null);

  -- Programar Tarea 1 a las 10:00 (10:00–11:00)
  t1 := public.schedule_personal_task(t1.id, scheduled_time, t1.updated_at, 60, false);
  if t1.scheduled_at is distinct from scheduled_time then
    raise exception 'TEST FAILED: Task 1 not scheduled correctly';
  end if;

  -- Intentar programar Tarea 2 en horario solapado (10:30–11:30) vía RPC
  begin
    perform public.schedule_personal_task(t2.id, overlapping_time, t2.updated_at, 60, false);
    raise exception 'TEST FAILED: Sequential overlapping schedule accepted';
  exception when sqlstate '23P01' then
    null; -- Éxito: solapamiento detectado y bloqueado
  end;

  -- Intentar programar Tarea 2 dentro del margen de 15 minutos (ej. 11:10 Bogotá, cuando t1 termina a las 11:00 y requiere 15 min de margen)
  begin
    perform public.schedule_personal_task(t2.id, (future_monday::text || ' 11:10:00-05')::timestamptz, t2.updated_at, 60, false);
    raise exception 'TEST FAILED: Buffer violation accepted by schedule_personal_task';
  exception when sqlstate '23P01' then
    null; -- Éxito: margen protegido
  end;

  -- Intentar eludir mediante UPDATE manual directo sobre Tarea 2 para solapar con Tarea 1
  begin
    update public.personal_tasks
    set scheduled_at = overlapping_time, estimated_minutes = 60
    where id = t2.id;
    raise exception 'TEST FAILED: Manual UPDATE bypassed schedule overlap check';
  exception when sqlstate '23P01' then
    null; -- Éxito: el trigger capturó el intento de elusión manual
  end;

  -- Intentar eludir mediante INSERT manual directo con horario solapado
  begin
    t3 := public.create_personal_task('70000000-0000-4000-8000-000000000013', 'Tarea 3', null, 'low', 60, null, overlapping_time);
    raise exception 'TEST FAILED: Manual INSERT bypassed schedule overlap check';
  exception when sqlstate '23P01' then
    null; -- Éxito: el trigger capturó el INSERT con solapamiento
  end;

  -- Verificar rechazo por horario fuera de disponibilidad (ej. 22:00 de la noche)
  begin
    perform public.schedule_personal_task(t2.id, (future_monday::text || ' 22:00:00-05')::timestamptz, t2.updated_at, 60, false);
    raise exception 'TEST FAILED: Schedule outside availability accepted';
  exception when sqlstate '22023' then
    null; -- Éxito
  end;

  -- Programar Tarea 2 en un horario libre respetando el margen (11:15 a 12:15)
  t2 := public.schedule_personal_task(t2.id, (future_monday::text || ' 11:15:00-05')::timestamptz, t2.updated_at, 60, false);
  if t2.scheduled_at is null then
    raise exception 'TEST FAILED: Valid non-overlapping schedule rejected';
  end if;

  -- Intentar programar Tarea 4 a las 14:15 Bogotá (en conflicto con la reunión externa de Google 14:00–15:00)
  t3 := public.create_personal_task('70000000-0000-4000-8000-000000000014', 'Tarea 4', null, 'medium', 30, null, null);
  begin
    perform public.schedule_personal_task(t3.id, (future_monday::text || ' 14:15:00-05')::timestamptz, t3.updated_at, 30, false);
    raise exception 'TEST FAILED: Conflict with external calendar event was not detected';
  exception when sqlstate '23P01' then
    null; -- Éxito: conflicto con calendario externo detectado y bloqueado
  end;
end $$;

-- Verificar aislamiento: User B puede programar en el mismo horario sin interferencia de User A
set local request.jwt.claim.sub = '74444444-4444-4444-8444-444444444444';

insert into public.task_scheduling_preferences(user_id, buffer_minutes, all_day_blocks, slots)
values (
  '74444444-4444-4444-8444-444444444444',
  15,
  true,
  '[{"day_of_week": 1, "start_time": "09:00", "end_time": "18:00"}]'::jsonb
);

do $$
declare
  b_task public.personal_tasks;
  future_monday date;
  same_time timestamptz;
begin
  future_monday := (now() at time zone 'America/Bogota')::date + ((8 - extract(isodow from (now() at time zone 'America/Bogota'))::integer) % 7 + 7);
  same_time := (future_monday::text || ' 10:00:00-05')::timestamptz;

  b_task := public.create_personal_task('70000000-0000-4000-8000-000000000021', 'Tarea B', null, 'medium', 60, null, null);
  -- User B programa exactamente en el mismo horario que User A (10:00 AM)
  b_task := public.schedule_personal_task(b_task.id, same_time, b_task.updated_at, 60, true);
  if b_task.scheduled_at is distinct from same_time then
    raise exception 'TEST FAILED: User B isolated schedule failed';
  end if;
end $$;

reset role;
select 'PASS: Sequential checks of trigger enforcement, manual edit protection, buffer, external calendar conflict and user isolation; not a concurrent race.' as result;
rollback;
