-- Rechaza explícitamente reservas vacías; no modifica la migración ya aplicada.
create or replace function public.finish_icloud_operation(p_user_id uuid,p_token uuid,p_generation uuid,p_action text,p_payload jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare op private.icloud_operations; conn public.icloud_connections; item jsonb; cal_id uuid; win_id uuid; keep_ids uuid[]:='{}';
begin
  select * into op from private.icloud_operations where user_id=p_user_id for update;
  if not found or p_token is null or op.token is null or op.expires_at is null or op.token is distinct from p_token or op.expires_at<=now() then raise exception 'operation_cancelled'; end if;
  select * into conn from public.icloud_connections where user_id=p_user_id for update;
  if conn.generation is distinct from p_generation then raise exception 'operation_cancelled'; end if;
  if p_action='connect' then
    insert into public.icloud_connections(user_id,status) values(p_user_id,'connected')
    on conflict(user_id) do update set generation=gen_random_uuid(),status='connected',error_code=null,updated_at=now() returning * into conn;
    delete from public.icloud_windows where connection_id=conn.id;
    delete from public.icloud_calendars where connection_id=conn.id;
    insert into private.icloud_credentials(connection_id,encrypted) values(conn.id,p_payload->>'encrypted')
    on conflict(connection_id) do update set encrypted=excluded.encrypted;
  elsif conn.status is distinct from 'connected' then raise exception 'reconnect_required'; end if;

  if p_action in ('connect','discover') then
    if jsonb_array_length(p_payload->'calendars')>100 then raise exception 'limit_reached'; end if;
    for item in select value from jsonb_array_elements(p_payload->'calendars') loop
      select c.id into cal_id from public.icloud_calendars c join private.icloud_remote_calendars r on r.calendar_id=c.id
        where c.connection_id=conn.id and r.href=item->>'href';
      if cal_id is null then
        insert into public.icloud_calendars(connection_id,user_id,name,color) values(conn.id,p_user_id,item->>'name',item->>'color') returning id into cal_id;
        insert into private.icloud_remote_calendars(calendar_id,href) values(cal_id,item->>'href');
      else update public.icloud_calendars set name=item->>'name',color=item->>'color' where id=cal_id; end if;
      keep_ids:=array_append(keep_ids,cal_id);
    end loop;
    delete from public.icloud_calendars where connection_id=conn.id and not(id=any(keep_ids));
    -- Un descubrimiento completo invalida ventanas para recoger cambios de acceso y selección.
    delete from public.icloud_windows where connection_id=conn.id;
    update public.icloud_connections set generation=gen_random_uuid() where id=conn.id;
  elsif p_action='select' then
    if jsonb_array_length(p_payload->'ids')>15 then raise exception 'limit_reached'; end if;
    for item in select value from jsonb_array_elements(p_payload->'ids') loop
      cal_id:=(item#>>'{}')::uuid;
      if not exists(select 1 from public.icloud_calendars where id=cal_id and connection_id=conn.id and user_id=p_user_id) then raise exception 'invalid_calendar'; end if;
      keep_ids:=array_append(keep_ids,cal_id);
    end loop;
    update public.icloud_calendars set selected=(id=any(keep_ids)) where connection_id=conn.id;
    delete from public.icloud_windows where connection_id=conn.id;
    update public.icloud_connections set generation=gen_random_uuid() where id=conn.id;
  elsif p_action='sync' then
    if jsonb_array_length(p_payload->'events')>4000 then raise exception 'limit_reached'; end if;
    insert into public.icloud_windows(connection_id,user_id,generation,start_on,end_on) values(conn.id,p_user_id,conn.generation,(p_payload->>'start_on')::date,(p_payload->>'start_on')::date+7)
      on conflict(connection_id,start_on) do update set synced_at=now(),generation=excluded.generation returning id into win_id;
    delete from public.icloud_events where window_id=win_id;
    for item in select value from jsonb_array_elements(p_payload->'events') loop
      cal_id:=(item->>'calendar_id')::uuid;
      if not exists(select 1 from public.icloud_calendars where id=cal_id and connection_id=conn.id and user_id=p_user_id and selected) then raise exception 'invalid_calendar'; end if;
      insert into public.icloud_events(window_id,calendar_id,user_id,occurrence_key,title,description,location,url,all_day,starts_at,ends_at,start_on,end_on)
      values(win_id,cal_id,p_user_id,item->>'occurrence_key',item->>'title',item->>'description',item->>'location',item->>'url',(item->>'all_day')::boolean,
        (item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,(item->>'start_on')::date,(item->>'end_on')::date);
    end loop;
    insert into private.icloud_resources(window_id,resources) values(win_id,p_payload->'resources') on conflict(window_id) do update set resources=excluded.resources;
    delete from public.icloud_windows where connection_id=conn.id and id not in
      (select id from public.icloud_windows where connection_id=conn.id order by synced_at desc,id limit 12);
  elsif p_action<>'release' then raise exception 'invalid_action'; end if;
  update public.icloud_connections set updated_at=now(),error_code=null where id=conn.id;
  update private.icloud_operations set token=null,expires_at=null where user_id=p_user_id;
end $$;

