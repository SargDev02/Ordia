-- El navegador solo puede consultar metadatos y copias de eventos propios.
create table public.icloud_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  status text not null check (status in ('connected','reconnect','disconnected')),
  error_code text,
  updated_at timestamptz not null default now()
);
create table public.icloud_calendars (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.icloud_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  color text not null default '#4f8068' check (color ~ '^#[0-9a-fA-F]{6}$'),
  selected boolean not null default false,
  unique(connection_id,id)
);
create index icloud_calendars_owner_idx on public.icloud_calendars(user_id,connection_id);
create table public.icloud_windows (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.icloud_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  generation uuid not null,
  start_on date not null,
  end_on date not null,
  synced_at timestamptz not null default now(),
  check (end_on = start_on + 7),
  unique(connection_id,start_on)
);
create index icloud_windows_owner_idx on public.icloud_windows(user_id,start_on);
create table public.icloud_events (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.icloud_windows(id) on delete cascade,
  calendar_id uuid not null references public.icloud_calendars(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  occurrence_key text not null check (char_length(occurrence_key) <= 128),
  title text not null check (char_length(title) <= 500),
  description text not null default '' check (char_length(description) <= 10000),
  location text not null default '' check (char_length(location) <= 1000),
  url text,
  all_day boolean not null,
  starts_at timestamptz,
  ends_at timestamptz,
  start_on date,
  end_on date,
  check ((all_day and start_on is not null and end_on > start_on and starts_at is null and ends_at is null)
    or (not all_day and starts_at is not null and ends_at >= starts_at and start_on is null and end_on is null)),
  unique(window_id,calendar_id,occurrence_key)
);
create index icloud_events_owner_idx on public.icloud_events(user_id,window_id);

create table private.icloud_credentials (
  connection_id uuid primary key references public.icloud_connections(id) on delete cascade,
  encrypted text not null check (char_length(encrypted) < 10000)
);
create table private.icloud_remote_calendars (
  calendar_id uuid primary key references public.icloud_calendars(id) on delete cascade,
  href text not null,
  unique(href,calendar_id)
);
create table private.icloud_resources (
  window_id uuid primary key references public.icloud_windows(id) on delete cascade,
  resources jsonb not null
);
create table private.icloud_operations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token uuid,
  expires_at timestamptz,
  rate_start timestamptz not null default now(),
  attempts integer not null default 0,
  connect_attempts integer not null default 0
);

alter table public.icloud_connections enable row level security;
alter table public.icloud_calendars enable row level security;
alter table public.icloud_windows enable row level security;
alter table public.icloud_events enable row level security;
alter table private.icloud_credentials enable row level security;
alter table private.icloud_remote_calendars enable row level security;
alter table private.icloud_resources enable row level security;
alter table private.icloud_operations enable row level security;
revoke all on public.icloud_connections,public.icloud_calendars,public.icloud_windows,public.icloud_events from public,anon,authenticated;
grant select on public.icloud_connections,public.icloud_calendars,public.icloud_windows,public.icloud_events to authenticated;
revoke all on private.icloud_credentials,private.icloud_remote_calendars,private.icloud_resources,private.icloud_operations from public,anon,authenticated;
grant usage on schema private to service_role;
grant all on public.icloud_connections,public.icloud_calendars,public.icloud_windows,public.icloud_events,
  private.icloud_credentials,private.icloud_remote_calendars,private.icloud_resources,private.icloud_operations to service_role;
create policy "Own iCloud connection" on public.icloud_connections for select to authenticated using ((select auth.uid())=user_id);
create policy "Own iCloud calendars" on public.icloud_calendars for select to authenticated using ((select auth.uid())=user_id);
create policy "Own iCloud windows" on public.icloud_windows for select to authenticated using ((select auth.uid())=user_id);
create policy "Own iCloud events" on public.icloud_events for select to authenticated using ((select auth.uid())=user_id);

create function public.begin_icloud_operation(p_user_id uuid,p_kind text,p_start_on date)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare op private.icloud_operations; conn public.icloud_connections; result jsonb;
begin
  if p_kind not in ('connect','discover','select','sync') then raise exception 'invalid_action'; end if;
  insert into private.icloud_operations(user_id) values(p_user_id) on conflict do nothing;
  select * into op from private.icloud_operations where user_id=p_user_id for update;
  if op.expires_at>now() then raise exception 'sync_busy'; end if;
  if op.rate_start < now()-interval '15 minutes' then op.rate_start:=now(); op.attempts:=0; op.connect_attempts:=0; end if;
  if op.attempts>=30 or (p_kind='connect' and op.connect_attempts>=5) then raise exception 'rate_limited'; end if;
  update private.icloud_operations set token=gen_random_uuid(),expires_at=now()+interval '90 seconds',
    rate_start=op.rate_start,attempts=op.attempts+1,connect_attempts=op.connect_attempts+case when p_kind='connect' then 1 else 0 end
    where user_id=p_user_id returning * into op;
  select * into conn from public.icloud_connections where user_id=p_user_id;
  result:=jsonb_build_object('token',op.token,'connection',to_jsonb(conn),
    'encrypted',(select encrypted from private.icloud_credentials where connection_id=conn.id),
    'calendars',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('href',r.href)),'[]'::jsonb)
      from public.icloud_calendars c join private.icloud_remote_calendars r on r.calendar_id=c.id where c.connection_id=conn.id),
    'window',(select to_jsonb(w) from public.icloud_windows w where w.connection_id=conn.id and w.start_on=p_start_on),
    'resources',(select r.resources from private.icloud_resources r join public.icloud_windows w on w.id=r.window_id where w.connection_id=conn.id and w.start_on=p_start_on));
  return result;
end $$;

create function public.finish_icloud_operation(p_user_id uuid,p_token uuid,p_generation uuid,p_action text,p_payload jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare op private.icloud_operations; conn public.icloud_connections; item jsonb; cal_id uuid; win_id uuid; keep_ids uuid[]:='{}';
begin
  select * into op from private.icloud_operations where user_id=p_user_id for update;
  if not found or op.token is distinct from p_token or op.expires_at<=now() then raise exception 'operation_cancelled'; end if;
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

create function public.fail_icloud_operation(p_user_id uuid,p_token uuid,p_code text,p_reconnect boolean)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from private.icloud_operations where user_id=p_user_id and token=p_token for update;
  if not found then return; end if;
  update public.icloud_connections set error_code=left(p_code,80),status=case when p_reconnect then 'reconnect' else status end,updated_at=now()
    where user_id=p_user_id and status<>'disconnected';
  update private.icloud_operations set token=null,expires_at=null where user_id=p_user_id;
end $$;

create function public.disconnect_icloud(p_user_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare conn_id uuid;
begin
  -- Toma el mismo bloqueo que el commit e invalida cualquier sincronización en vuelo.
  insert into private.icloud_operations(user_id) values(p_user_id) on conflict do nothing;
  perform 1 from private.icloud_operations where user_id=p_user_id for update;
  update private.icloud_operations set token=null,expires_at=null where user_id=p_user_id;
  update public.icloud_connections set status='disconnected',generation=gen_random_uuid(),error_code=null,updated_at=now() where user_id=p_user_id returning id into conn_id;
  delete from private.icloud_credentials where connection_id=conn_id;
  delete from public.icloud_windows where connection_id=conn_id;
  delete from public.icloud_calendars where connection_id=conn_id;
end $$;
revoke all on function public.begin_icloud_operation(uuid,text,date),public.finish_icloud_operation(uuid,uuid,uuid,text,jsonb),public.fail_icloud_operation(uuid,uuid,text,boolean),public.disconnect_icloud(uuid) from public,anon,authenticated;
grant execute on function public.begin_icloud_operation(uuid,text,date),public.finish_icloud_operation(uuid,uuid,uuid,text,jsonb),public.fail_icloud_operation(uuid,uuid,text,boolean),public.disconnect_icloud(uuid) to service_role;
-- Una notificación UPDATE del estado invalida la copia en otros dispositivos; no se escuchan DELETE.
alter publication supabase_realtime add table public.icloud_connections;
