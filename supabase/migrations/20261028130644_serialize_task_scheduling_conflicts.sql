-- Protección completa contra conflictos del planificador de tareas.
-- No modifica 20261028020000: reemplaza funciones mediante una migración nueva.
--
-- 1. Serialización por usuario: toda escritura que hace que una tarea pendiente ocupe
--    un intervalo futuro toma pg_advisory_xact_lock con una clave derivada del usuario.
--    La comprobación y la escritura ocurren bajo ese bloqueo y se liberan al confirmar,
--    por lo que dos solicitudes simultáneas para tareas distintas no pueden aceptar
--    intervalos incompatibles.
-- 2. Orden de bloqueos: primero la fila de la tarea y después el bloqueo del usuario,
--    igual que una actualización directa (UPDATE bloquea la fila antes del trigger).
-- 3. Duración ocupada: estimated_minutes o, si falta, una reserva preventiva de
--    30 minutos, la misma regla que usa el motor de sugerencias del navegador.
-- 4. Los calendarios externos se validan contra la última copia sincronizada. Ordia no
--    puede bloquear cambios posteriores en Google ni iCloud.

-- Validación de disponibilidad en el servidor (antes solo se validaba en el navegador).
create or replace function public.validate_task_scheduling_preferences() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.created_at is distinct from old.created_at then
      raise exception 'Preferences identity cannot change' using errcode = '23514';
    end if;
  end if;

  if jsonb_typeof(new.slots) is distinct from 'array' or jsonb_array_length(new.slots) > 50 then
    raise exception 'invalid_availability_slots' using errcode = '23514';
  end if;

  if exists (
    select 1 from jsonb_array_elements(new.slots) s(item)
    where jsonb_typeof(s.item) is distinct from 'object'
      or coalesce(jsonb_typeof(s.item -> 'day_of_week'), '') <> 'number'
      or coalesce(s.item ->> 'day_of_week', '') !~ '^[1-7]$'
      or coalesce(s.item ->> 'start_time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or coalesce(s.item ->> 'end_time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or (s.item ->> 'start_time') >= (s.item ->> 'end_time')
  ) then
    raise exception 'invalid_availability_slots' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(new.slots) with ordinality a(item, i)
    join jsonb_array_elements(new.slots) with ordinality b(item, j)
      on a.i < b.j
     and a.item ->> 'day_of_week' = b.item ->> 'day_of_week'
     and (a.item ->> 'start_time') < (b.item ->> 'end_time')
     and (b.item ->> 'start_time') < (a.item ->> 'end_time')
  ) then
    raise exception 'overlapping_availability_slots' using errcode = '23514';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

-- Invariante para todas las rutas de escritura (sugerencia aceptada, edición manual,
-- creación con programación y reactivación de una tarea completada): dos tareas
-- pendientes del mismo usuario no pueden ocupar intervalos futuros superpuestos.
create function public.validate_personal_task_schedule() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  v_end timestamptz;
  v_conflict_title text;
begin
  if new.deleted_at is not null or new.is_completed or new.scheduled_at is null then
    return new;
  end if;

  -- Cambios que no alteran intervalo ni estado (título, prioridad...) no se bloquean.
  if TG_OP = 'UPDATE'
     and new.scheduled_at is not distinct from old.scheduled_at
     and new.estimated_minutes is not distinct from old.estimated_minutes
     and not old.is_completed
     and old.deleted_at is null then
    return new;
  end if;

  v_end := new.scheduled_at + make_interval(mins => coalesce(new.estimated_minutes, 30));
  -- Un intervalo que ya terminó no puede quitar tiempo futuro a otra tarea.
  if v_end <= now() then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ordia.task_schedule:' || new.user_id::text, 0)
  );

  select t.title into v_conflict_title
  from public.personal_tasks t
  where t.user_id = new.user_id
    and t.id <> new.id
    and t.client_request_id <> new.client_request_id -- reintento idempotente de la misma creación
    and t.deleted_at is null
    and not t.is_completed
    and t.scheduled_at is not null
    and t.scheduled_at < v_end
    and t.scheduled_at + make_interval(mins => coalesce(t.estimated_minutes, 30)) > new.scheduled_at
  order by t.scheduled_at, t.id
  limit 1;

  if found then
    raise exception 'task_schedule_overlap' using errcode = '23P01', detail = v_conflict_title;
  end if;

  return new;
end;
$$;
revoke all on function public.validate_personal_task_schedule() from public, anon, authenticated;

-- El nombre ordena este trigger después de validate_personal_task (normalización previa).
create trigger validate_personal_task_schedule before insert or update on public.personal_tasks
for each row execute function public.validate_personal_task_schedule();

-- Aceptación de una sugerencia: vuelve a validar todo con los datos actuales del servidor.
drop function public.schedule_personal_task(uuid, timestamptz, timestamptz, integer);

create function public.schedule_personal_task(
  p_task_id uuid,
  p_scheduled_at timestamptz,
  p_expected_updated_at timestamptz,
  p_estimated_minutes integer default null,
  p_accept_unverified_calendars boolean default false
) returns public.personal_tasks
language plpgsql security invoker set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.personal_tasks;
  v_prefs public.task_scheduling_preferences;
  v_icloud public.icloud_connections;
  v_google public.google_connections;
  v_minutes integer;
  v_end timestamptz;
  v_buffer interval;
  v_local_start timestamp;
  v_local_end timestamp;
  v_day date;
  v_first_day date;
  v_last_day date;
  v_today date := (now() at time zone 'America/Bogota')::date;
  v_title text;
  v_unverified text[] := '{}';
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  -- 1. Tarea: propiedad, estado y versión (bloquea la fila).
  select * into v_task from public.personal_tasks
  where id = p_task_id and user_id = v_uid and deleted_at is null
  for update;
  if not found then
    raise exception 'task_not_found' using errcode = 'P0002';
  end if;
  if v_task.updated_at is distinct from p_expected_updated_at then
    raise exception 'task_modified' using errcode = '40001';
  end if;
  if v_task.is_completed then
    raise exception 'task_completed' using errcode = '22023';
  end if;

  -- Quitar la programación libera tiempo; no requiere más comprobaciones.
  if p_scheduled_at is null then
    update public.personal_tasks set scheduled_at = null where id = v_task.id returning * into v_task;
    return v_task;
  end if;

  -- 2. Serializa comprobación y escritura de todas las tareas del usuario.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ordia.task_schedule:' || v_uid::text, 0)
  );

  -- 3. Duración positiva y horario futuro.
  if p_estimated_minutes is not null and p_estimated_minutes <= 0 then
    raise exception 'duration_required' using errcode = '22023';
  end if;
  v_minutes := coalesce(p_estimated_minutes, v_task.estimated_minutes);
  if v_minutes is null or v_minutes <= 0 then
    raise exception 'duration_required' using errcode = '22023';
  end if;
  if p_scheduled_at < now() then
    raise exception 'schedule_in_past' using errcode = '22023';
  end if;
  v_end := p_scheduled_at + make_interval(mins => v_minutes);

  -- 4. Disponibilidad y margen actuales.
  select * into v_prefs from public.task_scheduling_preferences where user_id = v_uid;
  if not found or jsonb_array_length(v_prefs.slots) = 0 then
    raise exception 'availability_required' using errcode = '22023';
  end if;
  v_buffer := make_interval(mins => v_prefs.buffer_minutes);
  v_local_start := p_scheduled_at at time zone 'America/Bogota';
  v_local_end := v_end at time zone 'America/Bogota';
  v_day := v_local_start::date;

  if not exists (
    select 1 from jsonb_array_elements(v_prefs.slots) s(item)
    where (s.item ->> 'day_of_week')::integer = extract(isodow from v_day)::integer
      and v_local_start >= v_day + (s.item ->> 'start_time')::time
      and v_local_end <= v_day + (s.item ->> 'end_time')::time
  ) then
    raise exception 'outside_availability' using errcode = '22023';
  end if;

  -- 5. Fecha límite: una tarea a tiempo debe terminar antes de acabar su día de vencimiento.
  if v_task.due_on is not null and v_task.due_on >= v_today
     and v_local_end > (v_task.due_on + 1)::timestamp then
    raise exception 'after_due_date' using errcode = '22023';
  end if;

  -- 6. Otras tareas programadas, respetando el margen.
  select t.title into v_title
  from public.personal_tasks t
  where t.user_id = v_uid
    and t.id <> v_task.id
    and t.deleted_at is null
    and not t.is_completed
    and t.scheduled_at is not null
    and t.scheduled_at < v_end + v_buffer
    and t.scheduled_at + make_interval(mins => coalesce(t.estimated_minutes, 30)) > p_scheduled_at - v_buffer
  order by t.scheduled_at, t.id
  limit 1;
  if found then
    raise exception 'task_schedule_overlap' using errcode = '23P01', detail = v_title;
  end if;

  -- 7. Eventos de la última copia sincronizada de los calendarios seleccionados.
  --    Todos los eventos guardados cuentan como ocupados (los cancelados no se guardan).
  select x.title into v_title
  from (
    select e.title, e.all_day, e.starts_at, e.ends_at, e.start_on, e.end_on
    from public.icloud_events e
    join public.icloud_windows w on w.id = e.window_id
    join public.icloud_connections c on c.id = w.connection_id and c.generation = w.generation and c.status <> 'disconnected'
    join public.icloud_calendars k on k.id = e.calendar_id and k.selected
    where e.user_id = v_uid
    union all
    select e.title, e.all_day, e.starts_at, e.ends_at, e.start_on, e.end_on
    from public.google_events e
    join public.google_windows w on w.id = e.window_id
    join public.google_connections c on c.id = w.connection_id and c.generation = w.generation and c.status <> 'disconnected'
    join public.google_calendars k on k.id = e.calendar_id and k.selected
    where e.user_id = v_uid
  ) x
  where (not x.all_day and x.starts_at < v_end + v_buffer and x.ends_at > p_scheduled_at - v_buffer)
     or (x.all_day and v_prefs.all_day_blocks and x.start_on <= v_day and x.end_on > v_day)
  order by x.all_day, x.starts_at nulls first
  limit 1;
  if found then
    raise exception 'calendar_event_conflict' using errcode = '23P01', detail = v_title;
  end if;

  -- 8. Cobertura y vigencia: cada día local afectado (con márgenes) debe estar cubierto por
  --    una copia de la generación actual sincronizada hace menos de 24 horas y sin error.
  v_first_day := ((p_scheduled_at - v_buffer) at time zone 'America/Bogota')::date;
  v_last_day := (((v_end + v_buffer) at time zone 'America/Bogota') - interval '1 microsecond')::date;

  select * into v_icloud from public.icloud_connections where user_id = v_uid and status <> 'disconnected';
  if found and exists (select 1 from public.icloud_calendars where connection_id = v_icloud.id and selected) then
    if v_icloud.status <> 'connected' or v_icloud.error_code is not null or exists (
      select 1 from generate_series(v_first_day::timestamp, v_last_day::timestamp, interval '1 day') d(day)
      where not exists (
        select 1 from public.icloud_windows w
        where w.connection_id = v_icloud.id and w.generation = v_icloud.generation
          and w.start_on <= d.day::date and w.end_on > d.day::date
          and w.synced_at >= now() - interval '24 hours'
      )
    ) then
      v_unverified := array_append(v_unverified, 'iCloud');
    end if;
  end if;

  select * into v_google from public.google_connections where user_id = v_uid and status <> 'disconnected';
  if found and exists (select 1 from public.google_calendars where connection_id = v_google.id and selected) then
    if v_google.status <> 'connected' or v_google.error_code is not null or exists (
      select 1 from generate_series(v_first_day::timestamp, v_last_day::timestamp, interval '1 day') d(day)
      where not exists (
        select 1 from public.google_windows w
        where w.connection_id = v_google.id and w.generation = v_google.generation
          and w.start_on <= d.day::date and w.end_on > d.day::date
          and w.synced_at >= now() - interval '24 hours'
      )
    ) then
      v_unverified := array_append(v_unverified, 'Google');
    end if;
  end if;

  if cardinality(v_unverified) > 0 and not coalesce(p_accept_unverified_calendars, false) then
    raise exception 'calendar_unverified' using errcode = '55000', detail = array_to_string(v_unverified, ', ');
  end if;

  -- 9. Escritura bajo el mismo bloqueo. El trigger repite la comprobación estricta.
  update public.personal_tasks
  set scheduled_at = p_scheduled_at, estimated_minutes = v_minutes
  where id = v_task.id
  returning * into v_task;

  return v_task;
end;
$$;

revoke all on function public.schedule_personal_task(uuid, timestamptz, timestamptz, integer, boolean) from public, anon;
grant execute on function public.schedule_personal_task(uuid, timestamptz, timestamptz, integer, boolean) to authenticated;
