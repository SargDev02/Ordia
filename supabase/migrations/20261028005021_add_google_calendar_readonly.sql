-- El navegador solo puede consultar metadatos y copias de eventos propios.
create table public.google_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  status text not null check (status in ('connected','reconnect','disconnected')),
  error_code text,
  updated_at timestamptz not null default now()
);
create table public.google_calendars (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.google_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  color text not null default '#4f8068' check (color ~ '^#[0-9a-fA-F]{6}$'),
  selected boolean not null default false,
  unique(connection_id,id)
);
create index google_calendars_owner_idx on public.google_calendars(user_id,connection_id);
create table public.google_windows (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.google_connections(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  generation uuid not null,
  start_on date not null,
  end_on date not null,
  synced_at timestamptz not null default now(),
  check (end_on = start_on + 7),
  unique(connection_id,start_on)
);
create index google_windows_owner_idx on public.google_windows(user_id,start_on);
create table public.google_events (
  id uuid primary key default gen_random_uuid(),
  window_id uuid not null references public.google_windows(id) on delete cascade,
  calendar_id uuid not null references public.google_calendars(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  occurrence_key text not null check (char_length(occurrence_key) <= 128),
  provider_event_id text not null,
  original_start jsonb not null default '{}'::jsonb,
  original_end jsonb not null default '{}'::jsonb,
  recurring_event_id text,
  recurring_original_start jsonb,
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
create index google_events_owner_idx on public.google_events(user_id,window_id);

create table private.google_credentials (
  connection_id uuid primary key references public.google_connections(id) on delete cascade,
  encrypted text not null check (char_length(encrypted) < 10000)
);
create table private.google_remote_calendars (
  calendar_id uuid primary key references public.google_calendars(id) on delete cascade,
  remote_id text not null,
  unique(remote_id,calendar_id)
);
create table private.google_operations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token uuid,
  expires_at timestamptz,
  rate_start timestamptz not null default now(),
  attempts integer not null default 0,
  connect_attempts integer not null default 0
);

alter table public.google_connections enable row level security;
alter table public.google_calendars enable row level security;
alter table public.google_windows enable row level security;
alter table public.google_events enable row level security;
alter table private.google_credentials enable row level security;
alter table private.google_remote_calendars enable row level security;
alter table private.google_operations enable row level security;
revoke all on public.google_connections,public.google_calendars,public.google_windows,public.google_events from public,anon,authenticated;
grant select on public.google_connections,public.google_calendars,public.google_windows,public.google_events to authenticated;
revoke all on private.google_credentials,private.google_remote_calendars,private.google_operations from public,anon,authenticated;
grant usage on schema private to service_role;
grant all on public.google_connections,public.google_calendars,public.google_windows,public.google_events,
  private.google_credentials,private.google_remote_calendars,private.google_operations to service_role;
create policy "Own Google connection" on public.google_connections for select to authenticated using ((select auth.uid())=user_id);
create policy "Own Google calendars" on public.google_calendars for select to authenticated using ((select auth.uid())=user_id);
create policy "Own Google windows" on public.google_windows for select to authenticated using ((select auth.uid())=user_id);
create policy "Own Google events" on public.google_events for select to authenticated using ((select auth.uid())=user_id);

create function public.begin_google_operation(p_user_id uuid,p_kind text,p_start_on date)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare op private.google_operations; conn public.google_connections; result jsonb;
begin
  if p_kind not in ('start','discover','select','sync') then raise exception 'invalid_action'; end if;
  insert into private.google_operations(user_id) values(p_user_id) on conflict do nothing;
  select * into op from private.google_operations where user_id=p_user_id for update;
  if op.expires_at>now() then raise exception 'sync_busy'; end if;
  if op.rate_start < now()-interval '15 minutes' then op.rate_start:=now(); op.attempts:=0; op.connect_attempts:=0; end if;
  if op.attempts>=30 or (p_kind='start' and op.connect_attempts>=5) then raise exception 'rate_limited'; end if;
  update private.google_operations set token=gen_random_uuid(),expires_at=now()+interval '90 seconds',
    rate_start=op.rate_start,attempts=op.attempts+1,connect_attempts=op.connect_attempts+case when p_kind='start' then 1 else 0 end
    where user_id=p_user_id returning * into op;
  select * into conn from public.google_connections where user_id=p_user_id;
  result:=jsonb_build_object('token',op.token,'connection',to_jsonb(conn),
    'encrypted',(select encrypted from private.google_credentials where connection_id=conn.id),
    'calendars',(select coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('remote_id',r.remote_id)),'[]'::jsonb)
      from public.google_calendars c join private.google_remote_calendars r on r.calendar_id=c.id where c.connection_id=conn.id),
    'window',(select to_jsonb(w) from public.google_windows w where w.connection_id=conn.id and w.start_on=p_start_on)
  );
  return result;
end $$;

create function public.finish_google_operation(p_user_id uuid,p_token uuid,p_generation uuid,p_action text,p_payload jsonb)
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
    -- Un descubrimiento completo invalida ventanas para recoger cambios de acceso y selección.
    delete from public.google_windows where connection_id=conn.id;
    update public.google_connections set generation=gen_random_uuid() where id=conn.id;
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

create function public.fail_google_operation(p_user_id uuid,p_token uuid,p_code text,p_reconnect boolean)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from private.google_operations where user_id=p_user_id and token=p_token for update;
  if not found then return; end if;
  update public.google_connections set error_code=left(p_code,80),status=case when p_reconnect then 'reconnect' else status end,updated_at=now()
    where user_id=p_user_id and status<>'disconnected';
  update private.google_operations set token=null,expires_at=null where user_id=p_user_id;
end $$;

create table private.google_oauth_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  encrypted text not null,
  return_origin text not null check (return_origin in ('http://localhost:5173','http://127.0.0.1:5173','https://ordia-seven.vercel.app')),
  generation uuid,
  phase text not null default 'created' check (phase in ('created','authorized','consumed')),
  browser_hash text,
  expires_at timestamptz not null default now()+interval '10 minutes'
);
alter table private.google_oauth_states enable row level security;
revoke all on private.google_oauth_states from public,anon,authenticated;
grant all on private.google_oauth_states to service_role;

create function public.create_google_oauth_state(p_user_id uuid,p_hash text,p_encrypted text,p_origin text)
returns void language plpgsql security invoker set search_path='' as $$
declare context jsonb;
begin
  context:=public.begin_google_operation(p_user_id,'start',null);
  delete from private.google_oauth_states where user_id=p_user_id;
  insert into private.google_oauth_states(state_hash,user_id,encrypted,return_origin,generation)
    values(p_hash,p_user_id,p_encrypted,p_origin,(context#>>'{connection,generation}')::uuid);
  update private.google_operations set token=null,expires_at=null where user_id=p_user_id;
end $$;

create function public.activate_google_oauth(p_hash text,p_origin text,p_browser_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare state private.google_oauth_states;
begin
  update private.google_oauth_states set phase='authorized',browser_hash=p_browser_hash
    where state_hash=p_hash and phase='created' and expires_at>now() and return_origin=p_origin
    returning * into state;
  if not found or p_browser_hash is null or p_browser_hash !~ '^[a-f0-9]{64}$' then raise exception 'oauth_state_invalid'; end if;
  return to_jsonb(state);
end $$;

create function public.consume_google_oauth(p_hash text,p_browser_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare state private.google_oauth_states;
begin
  update private.google_oauth_states set phase='consumed'
    where state_hash=p_hash and phase='authorized' and expires_at>now() and browser_hash=p_browser_hash and p_browser_hash is not null
    returning * into state;
  if not found then raise exception 'oauth_state_invalid'; end if;
  return to_jsonb(state)||jsonb_build_object('existing_encrypted',(select cr.encrypted from private.google_credentials cr join public.google_connections c on c.id=cr.connection_id where c.user_id=state.user_id));
end $$;

create function public.finish_google_oauth(p_hash text,p_encrypted text,p_calendars jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare state private.google_oauth_states; owner_id uuid; op private.google_operations; conn public.google_connections;
begin
  select user_id into owner_id from private.google_oauth_states where state_hash=p_hash;
  if owner_id is null then raise exception 'oauth_state_invalid'; end if;
  select * into op from private.google_operations where user_id=owner_id for update;
  if op.expires_at>now() then raise exception 'sync_busy'; end if;
  select * into state from private.google_oauth_states where state_hash=p_hash for update;
  if not found or state.phase<>'consumed' or state.expires_at<=now() then raise exception 'oauth_state_invalid'; end if;
  select * into conn from public.google_connections where user_id=state.user_id for update;
  if conn.generation is distinct from state.generation then raise exception 'operation_cancelled'; end if;
  insert into public.google_connections(user_id,status) values(state.user_id,'connected')
    on conflict(user_id) do update set generation=gen_random_uuid(),status='connected',error_code=null,updated_at=now() returning * into conn;
  delete from public.google_windows where connection_id=conn.id;
  delete from public.google_calendars where connection_id=conn.id;
  update private.google_operations set token=gen_random_uuid(),expires_at=now()+interval '90 seconds' where user_id=owner_id returning * into op;
  perform public.finish_google_operation(state.user_id,op.token,conn.generation,'discover',jsonb_build_object('calendars',p_calendars));
  insert into private.google_credentials(connection_id,encrypted) values(conn.id,p_encrypted) on conflict(connection_id) do update set encrypted=excluded.encrypted;
  delete from private.google_oauth_states where state_hash=p_hash;
end $$;

create function public.store_google_tokens(p_user_id uuid,p_token uuid,p_generation uuid,p_encrypted text)
returns void language plpgsql security invoker set search_path='' as $$
declare op private.google_operations; conn public.google_connections;
begin
  select * into op from private.google_operations where user_id=p_user_id for update;
  if p_token is null or op.token is distinct from p_token or op.expires_at is null or op.expires_at<=now() then raise exception 'operation_cancelled'; end if;
  select * into conn from public.google_connections where user_id=p_user_id for update;
  if conn.id is null or conn.generation is distinct from p_generation or conn.status is distinct from 'connected' then raise exception 'operation_cancelled'; end if;
  update private.google_credentials set encrypted=p_encrypted where connection_id=conn.id;
end $$;

create function public.discard_google_oauth(p_hash text)
returns void language sql security invoker set search_path='' as $$ delete from private.google_oauth_states where state_hash=p_hash $$;

create function public.disconnect_google(p_user_id uuid)
returns text language plpgsql security invoker set search_path='' as $$
declare conn_id uuid; encrypted text;
begin
  -- Toma el mismo bloqueo que el commit e invalida cualquier sincronización en vuelo.
  insert into private.google_operations(user_id) values(p_user_id) on conflict do nothing;
  perform 1 from private.google_operations where user_id=p_user_id for update;
  update private.google_operations set token=null,expires_at=null where user_id=p_user_id;
  delete from private.google_oauth_states where user_id=p_user_id;
  update public.google_connections set status='disconnected',generation=gen_random_uuid(),error_code=null,updated_at=now() where user_id=p_user_id returning id into conn_id;
  select cr.encrypted into encrypted from private.google_credentials cr where connection_id=conn_id;
  delete from private.google_credentials where connection_id=conn_id;
  delete from public.google_windows where connection_id=conn_id;
  delete from public.google_calendars where connection_id=conn_id;
  return encrypted;
end $$;
revoke all on function public.begin_google_operation(uuid,text,date),public.finish_google_operation(uuid,uuid,uuid,text,jsonb),public.fail_google_operation(uuid,uuid,text,boolean),public.disconnect_google(uuid) from public,anon,authenticated;
grant execute on function public.begin_google_operation(uuid,text,date),public.finish_google_operation(uuid,uuid,uuid,text,jsonb),public.fail_google_operation(uuid,uuid,text,boolean),public.disconnect_google(uuid) to service_role;
revoke all on function public.create_google_oauth_state(uuid,text,text,text),public.activate_google_oauth(text,text,text),public.consume_google_oauth(text,text),public.finish_google_oauth(text,text,jsonb),public.store_google_tokens(uuid,uuid,uuid,text),public.discard_google_oauth(text) from public,anon,authenticated;
grant execute on function public.create_google_oauth_state(uuid,text,text,text),public.activate_google_oauth(text,text,text),public.consume_google_oauth(text,text),public.finish_google_oauth(text,text,jsonb),public.store_google_tokens(uuid,uuid,uuid,text),public.discard_google_oauth(text) to service_role;
-- Una notificación UPDATE del estado invalida la copia en otros dispositivos; no se escuchan DELETE.
alter publication supabase_realtime add table public.google_connections;
