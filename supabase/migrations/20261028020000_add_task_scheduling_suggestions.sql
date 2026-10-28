create table public.task_scheduling_preferences (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  buffer_minutes integer not null default 15 check (buffer_minutes between 0 and 120),
  all_day_blocks boolean not null default true,
  slots jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function public.validate_task_scheduling_preferences() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.created_at is distinct from old.created_at then
      raise exception 'Preferences identity cannot change' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger validate_task_scheduling_preferences before insert or update on public.task_scheduling_preferences
for each row execute function public.validate_task_scheduling_preferences();

alter table public.task_scheduling_preferences enable row level security;
revoke all on public.task_scheduling_preferences from public, anon, authenticated;
grant select, insert, update on public.task_scheduling_preferences to authenticated;

create policy "Select own scheduling preferences" on public.task_scheduling_preferences
for select to authenticated using ((select auth.uid()) = user_id);

create policy "Insert own scheduling preferences" on public.task_scheduling_preferences
for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "Update own scheduling preferences" on public.task_scheduling_preferences
for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

alter publication supabase_realtime add table public.task_scheduling_preferences;

create function public.schedule_personal_task(
  p_task_id uuid,
  p_scheduled_at timestamptz,
  p_expected_updated_at timestamptz,
  p_estimated_minutes integer default null
) returns public.personal_tasks
language plpgsql security invoker set search_path = '' as $$
declare
  v_task public.personal_tasks;
begin
  select * into v_task from public.personal_tasks
  where id = p_task_id and user_id = (select auth.uid()) and deleted_at is null
  for update;

  if v_task.id is null then
    raise exception 'Task not found or deleted' using errcode = 'P0002';
  end if;

  if v_task.is_completed then
    raise exception 'Completed task cannot be scheduled' using errcode = '23514';
  end if;

  if v_task.updated_at is distinct from p_expected_updated_at then
    raise exception 'Task was modified concurrently' using errcode = '40001';
  end if;

  update public.personal_tasks
  set scheduled_at = p_scheduled_at,
      estimated_minutes = coalesce(p_estimated_minutes, estimated_minutes)
  where id = p_task_id
  returning * into v_task;

  return v_task;
end;
$$;

revoke all on function public.schedule_personal_task(uuid, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.schedule_personal_task(uuid, timestamptz, timestamptz, integer) to authenticated;
