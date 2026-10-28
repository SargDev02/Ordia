create table public.personal_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_request_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text check (description is null or char_length(description) <= 5000),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  estimated_minutes integer check (estimated_minutes between 1 and 1000000),
  due_on date check (due_on between date '1900-01-01' and date '9999-12-31'),
  scheduled_at timestamptz check (scheduled_at between timestamptz '1900-01-01 00:00:00-05' and timestamptz '9999-12-31 23:59:59-05'),
  is_completed boolean not null default false,
  completed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, client_request_id),
  check (is_completed = (completed_at is not null))
);

create index personal_tasks_user_pending_idx on public.personal_tasks(user_id, due_on, scheduled_at) where deleted_at is null and not is_completed;
create index personal_tasks_user_completed_idx on public.personal_tasks(user_id, completed_at desc) where deleted_at is null and is_completed;

create function public.validate_personal_task() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.id is distinct from old.id
      or new.client_request_id is distinct from old.client_request_id
      or new.created_at is distinct from old.created_at then
      raise exception 'Task identity cannot change' using errcode = '23514';
    end if;
    if old.deleted_at is not null then
      raise exception 'Deleted task cannot change' using errcode = '23514';
    end if;
    new.completed_at := case when not new.is_completed then null
      when old.is_completed then old.completed_at else now() end;
  else
    new.is_completed := false;
    new.completed_at := null;
    new.deleted_at := null;
    new.created_at := now();
  end if;
  new.title := btrim(new.title);
  new.updated_at := now();
  if new.deleted_at is not null then new.deleted_at := now(); end if;
  return new;
end;
$$;
revoke all on function public.validate_personal_task() from public, anon, authenticated;
create trigger validate_personal_task before insert or update on public.personal_tasks
for each row execute function public.validate_personal_task();

alter table public.personal_tasks enable row level security;
revoke all on public.personal_tasks from public, anon, authenticated;
grant select on public.personal_tasks to authenticated;
grant insert (client_request_id, title, description, priority, estimated_minutes, due_on, scheduled_at) on public.personal_tasks to authenticated;
grant update (title, description, priority, estimated_minutes, due_on, scheduled_at, is_completed, deleted_at) on public.personal_tasks to authenticated;
-- Las bajas siguen visibles por RLS para comunicar UPDATE; la aplicación filtra deleted_at.
create policy "Select own tasks" on public.personal_tasks for select to authenticated using ((select auth.uid()) = user_id);
create policy "Insert own tasks" on public.personal_tasks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own tasks" on public.personal_tasks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create function public.create_personal_task(
  p_request_id uuid, p_title text, p_description text, p_priority text,
  p_estimated_minutes integer, p_due_on date, p_scheduled_at timestamptz
) returns public.personal_tasks language plpgsql security invoker set search_path = '' as $$
declare result public.personal_tasks;
begin
  insert into public.personal_tasks(client_request_id, title, description, priority, estimated_minutes, due_on, scheduled_at)
  values(p_request_id, p_title, p_description, p_priority, p_estimated_minutes, p_due_on, p_scheduled_at)
  on conflict (user_id, client_request_id) do nothing returning * into result;
  if result.id is null then
    select * into strict result from public.personal_tasks
    where user_id = (select auth.uid()) and client_request_id = p_request_id;
  end if;
  return result;
end;
$$;
revoke all on function public.create_personal_task(uuid, text, text, text, integer, date, timestamptz) from public, anon;
grant execute on function public.create_personal_task(uuid, text, text, text, integer, date, timestamptz) to authenticated;
alter publication supabase_realtime add table public.personal_tasks;
