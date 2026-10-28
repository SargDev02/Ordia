-- Un descubrimiento completo retira únicamente calendarios inaccesibles y sus eventos.
-- Conserva las ventanas y eventos todavía seleccionados si la consulta posterior falla.
create or replace function public.finish_google_operation(p_user_id uuid,p_token uuid,p_generation uuid,p_action text,p_payload jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare op private.google_operations; conn public.google_connections; item jsonb; cal_id uuid; win_id uuid; keep_ids uuid[]:='{}';
begin
  select * into op from private.google_operations where user_id=p_user_id for update;
  if not found or p_token is null or op.token is null or op.expires_at is null or op.token is distinct from p_token or op.expires_at<=now() then raise exception 'operation_cancelled'; end if;
  select * into conn from public.google_connections where user_id=p_user_id for update;
  if conn.generation is distinct from p_generation then raise exception 'operation_cancelled'; end if;
  if conn.status is distinct from 'connected' then raise exception 'reconnect_required'; end if;

  if p_action='discover' then
    if jsonb_array_length(p_payload->'calendars')>100 then raise exception 'limit_reached'; end if;
    for item in select value from jsonb_array_elements(p_payload->'calendars') loop
      select c.id into cal_id from public.google_calendars c join private.google_remote_calendars r on r.calendar_id=c.id
        where c.connection_id=conn.id and r.remote_id=item->>'remote_id';
      if cal_id is null then
        insert into public.google_calendars(connection_id,user_id,name,color) values(conn.id,p_user_id,item->>'name',item->>'color') returning id into cal_id;
        insert into private.google_remote_calendars(calendar_id,remote_id) values(cal_id,item->>'remote_id');
      else update public.google_calendars set name=item->>'name',color=item->>'color' where id=cal_id; end if;
      keep_ids:=array_append(keep_ids,cal_id);
    end loop;
    delete from public.google_calendars where connection_id=conn.id and not(id=any(keep_ids));
    -- No invalida ventanas: una lista completa no equivale a una consulta de eventos.
  elsif p_action='select' then
    if jsonb_array_length(p_payload->'ids')>15 then raise exception 'limit_reached'; end if;
    for item in select value from jsonb_array_elements(p_payload->'ids') loop
      cal_id:=(item#>>'{}')::uuid;
      if not exists(select 1 from public.google_calendars where id=cal_id and connection_id=conn.id and user_id=p_user_id) then raise exception 'invalid_calendar'; end if;
      keep_ids:=array_append(keep_ids,cal_id);
    end loop;
    update public.google_calendars set selected=(id=any(keep_ids)) where connection_id=conn.id;
    delete from public.google_windows where connection_id=conn.id;
    update public.google_connections set generation=gen_random_uuid() where id=conn.id;
  elsif p_action='sync' then
    if jsonb_array_length(p_payload->'events')>4000 then raise exception 'limit_reached'; end if;
    insert into public.google_windows(connection_id,user_id,generation,start_on,end_on) values(conn.id,p_user_id,conn.generation,(p_payload->>'start_on')::date,(p_payload->>'start_on')::date+7)
      on conflict(connection_id,start_on) do update set synced_at=now(),generation=excluded.generation returning id into win_id;
    delete from public.google_events where window_id=win_id;
    for item in select value from jsonb_array_elements(p_payload->'events') loop
      cal_id:=(item->>'calendar_id')::uuid;
      if not exists(select 1 from public.google_calendars where id=cal_id and connection_id=conn.id and user_id=p_user_id and selected) then raise exception 'invalid_calendar'; end if;
      insert into public.google_events(window_id,calendar_id,user_id,occurrence_key,provider_event_id,original_start,original_end,recurring_event_id,recurring_original_start,title,description,location,url,all_day,starts_at,ends_at,start_on,end_on)
      values(win_id,cal_id,p_user_id,item->>'occurrence_key',item->>'provider_event_id',item->'original_start',item->'original_end',item->>'recurring_event_id',item->'recurring_original_start',item->>'title',item->>'description',item->>'location',item->>'url',(item->>'all_day')::boolean,
        (item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,(item->>'start_on')::date,(item->>'end_on')::date);
    end loop;
    delete from public.google_windows where connection_id=conn.id and id not in
      (select id from public.google_windows where connection_id=conn.id order by synced_at desc,id limit 12);
  elsif p_action<>'release' then raise exception 'invalid_action'; end if;
  update public.google_connections set updated_at=now(),error_code=null where id=conn.id;
  update private.google_operations set token=null,expires_at=null where user_id=p_user_id;
end $$;
-- CREATE OR REPLACE conserva ACL; se reiteran explícitamente los privilegios mínimos.
revoke all on function public.finish_google_operation(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.finish_google_operation(uuid,uuid,uuid,text,jsonb) to service_role;
