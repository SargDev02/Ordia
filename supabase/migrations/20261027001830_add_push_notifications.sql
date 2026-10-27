create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  device_label text not null,
  user_agent text,
  active boolean not null default true,
  disabled_at timestamptz,
  disabled_reason text,
  last_seen_at timestamptz not null default now(),
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_subscriptions_endpoint_length_check check (char_length(endpoint) between 1 and 2048),
  constraint push_subscriptions_key_length_check check (
    char_length(p256dh) between 1 and 512 and char_length(auth) between 1 and 512
  ),
  constraint push_subscriptions_device_label_check check (char_length(btrim(device_label)) between 1 and 80),
  constraint push_subscriptions_user_agent_check check (user_agent is null or char_length(user_agent) <= 500),
  constraint push_subscriptions_disabled_reason_check check (
    disabled_reason is null or disabled_reason in ('user', 'expired', 'reassigned')
  ),
  constraint push_subscriptions_state_check check (
    (active and disabled_at is null and disabled_reason is null)
    or (not active and disabled_at is not null and disabled_reason is not null)
  ),
  constraint push_subscriptions_user_endpoint_unique unique (user_id, endpoint)
);

create unique index push_subscriptions_one_active_endpoint_idx
on public.push_subscriptions (endpoint)
where active;

create index push_subscriptions_user_active_idx
on public.push_subscriptions (user_id, active, last_seen_at desc);

create table public.push_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions (id) on delete restrict,
  fixed_expense_period_id uuid not null references public.fixed_expense_periods (id) on delete restrict,
  reminder_date date not null,
  reminder_kind text not null,
  status text not null default 'processing',
  run_id uuid not null,
  attempt_count integer not null default 1,
  http_status integer,
  error_code text,
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_notification_attempts_kind_check check (
    reminder_kind in ('day_before', 'due_today', 'overdue')
  ),
  constraint push_notification_attempts_status_check check (
    status in ('processing', 'sent', 'failed', 'invalid', 'skipped')
  ),
  constraint push_notification_attempts_count_check check (attempt_count between 1 and 3),
  constraint push_notification_attempts_http_status_check check (
    http_status is null or http_status between 100 and 599
  ),
  constraint push_notification_attempts_error_code_check check (
    error_code is null or char_length(error_code) <= 120
  ),
  constraint push_notification_attempts_unique unique (
    subscription_id, fixed_expense_period_id, reminder_date, reminder_kind
  )
);

create index push_notification_attempts_user_date_idx
on public.push_notification_attempts (user_id, reminder_date desc);

create index push_notification_attempts_status_idx
on public.push_notification_attempts (status, attempted_at);

alter table public.push_subscriptions enable row level security;
alter table public.push_notification_attempts enable row level security;

revoke all on table public.push_subscriptions from anon, authenticated;
revoke all on table public.push_notification_attempts from anon, authenticated;
grant select on table public.push_subscriptions to authenticated;

create policy "Users select own push subscriptions"
on public.push_subscriptions for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users select own push attempts"
on public.push_notification_attempts for select to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device_label text,
  p_user_agent text default null
)
returns public.push_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  result public.push_subscriptions;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if char_length(p_endpoint) not between 1 and 2048
    or char_length(p_p256dh) not between 1 and 512
    or char_length(p_auth) not between 1 and 512
    or char_length(btrim(p_device_label)) not between 1 and 80 then
    raise exception 'Invalid push subscription' using errcode = '22023';
  end if;

  update public.push_subscriptions
  set active = false,
      disabled_at = now(),
      disabled_reason = 'reassigned',
      updated_at = now()
  where endpoint = p_endpoint and active and user_id <> current_user_id;

  insert into public.push_subscriptions (
    user_id, endpoint, p256dh, auth, device_label, user_agent
  ) values (
    current_user_id, p_endpoint, p_p256dh, p_auth, btrim(p_device_label),
    nullif(left(p_user_agent, 500), '')
  )
  on conflict (user_id, endpoint) do update
  set p256dh = excluded.p256dh,
      auth = excluded.auth,
      device_label = excluded.device_label,
      user_agent = excluded.user_agent,
      active = true,
      disabled_at = null,
      disabled_reason = null,
      last_seen_at = now(),
      updated_at = now()
  returning * into result;

  return result;
end;
$$;

create or replace function public.disable_push_subscription(p_subscription_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  update public.push_subscriptions
  set active = false,
      disabled_at = coalesce(disabled_at, now()),
      disabled_reason = 'user',
      updated_at = now()
  where id = p_subscription_id and user_id = current_user_id;
  if not found then
    raise exception 'Push subscription does not exist' using errcode = '23503';
  end if;
end;
$$;

create or replace function public.disable_current_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
begin
  if current_user_id is null then return; end if;
  update public.push_subscriptions
  set active = false,
      disabled_at = coalesce(disabled_at, now()),
      disabled_reason = 'user',
      updated_at = now()
  where endpoint = p_endpoint and user_id = current_user_id and active;
end;
$$;

create or replace function public.claim_push_notification_attempt(
  p_subscription_id uuid,
  p_period_id uuid,
  p_reminder_date date,
  p_reminder_kind text,
  p_run_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  if p_reminder_kind not in ('day_before', 'due_today', 'overdue') then
    raise exception 'Invalid reminder kind' using errcode = '22023';
  end if;

  insert into public.push_notification_attempts (
    user_id, subscription_id, fixed_expense_period_id, reminder_date,
    reminder_kind, status, run_id
  )
  select subscription.user_id, subscription.id, period.id, p_reminder_date,
         p_reminder_kind, 'processing', p_run_id
  from public.push_subscriptions as subscription
  join public.fixed_expense_periods as period on period.user_id = subscription.user_id
  where subscription.id = p_subscription_id
    and subscription.active
    and period.id = p_period_id
    and period.transaction_id is null
    and period.cancelled_at is null
    and (
      (p_reminder_kind = 'day_before' and period.due_date = p_reminder_date + 1)
      or (p_reminder_kind = 'due_today' and period.due_date = p_reminder_date)
      or (p_reminder_kind = 'overdue' and period.due_date < p_reminder_date)
    )
  on conflict (subscription_id, fixed_expense_period_id, reminder_date, reminder_kind)
  do update set
    status = 'processing',
    run_id = excluded.run_id,
    attempt_count = public.push_notification_attempts.attempt_count + 1,
    http_status = null,
    error_code = null,
    attempted_at = now(),
    completed_at = null,
    updated_at = now()
  where public.push_notification_attempts.attempt_count < 3
    and (
      public.push_notification_attempts.status = 'failed'
      or (
        public.push_notification_attempts.status = 'processing'
        and public.push_notification_attempts.attempted_at < now() - interval '20 minutes'
      )
    )
  returning id into claimed_id;

  return claimed_id;
end;
$$;

create or replace function public.is_push_notification_attempt_deliverable(
  p_attempt_id uuid,
  p_run_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.push_notification_attempts as attempt
    join public.push_subscriptions as subscription on subscription.id = attempt.subscription_id
    join public.fixed_expense_periods as period on period.id = attempt.fixed_expense_period_id
    where attempt.id = p_attempt_id
      and attempt.run_id = p_run_id
      and attempt.status = 'processing'
      and subscription.active
      and period.transaction_id is null
      and period.cancelled_at is null
  );
$$;

create or replace function public.complete_push_notification_attempt(
  p_attempt_id uuid,
  p_run_id uuid,
  p_status text,
  p_http_status integer default null,
  p_error_code text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_subscription_id uuid;
begin
  if p_status not in ('sent', 'failed', 'invalid', 'skipped') then
    raise exception 'Invalid attempt status' using errcode = '22023';
  end if;

  update public.push_notification_attempts
  set status = p_status,
      http_status = p_http_status,
      error_code = nullif(left(p_error_code, 120), ''),
      completed_at = now(),
      updated_at = now()
  where id = p_attempt_id and run_id = p_run_id and status = 'processing'
  returning subscription_id into target_subscription_id;

  if target_subscription_id is null then
    raise exception 'Push attempt is no longer claimable' using errcode = '23503';
  end if;

  if p_status = 'sent' then
    update public.push_subscriptions
    set last_success_at = now(), last_seen_at = now(), updated_at = now()
    where id = target_subscription_id;
  elsif p_status = 'invalid' then
    update public.push_subscriptions
    set active = false,
        disabled_at = now(),
        disabled_reason = 'expired',
        updated_at = now()
    where id = target_subscription_id;
  end if;
end;
$$;

revoke execute on function public.register_push_subscription(text, text, text, text, text) from public, anon;
revoke execute on function public.disable_push_subscription(uuid) from public, anon;
revoke execute on function public.disable_current_push_subscription(text) from public, anon;
revoke execute on function public.claim_push_notification_attempt(uuid, uuid, date, text, uuid) from public, anon, authenticated;
revoke execute on function public.is_push_notification_attempt_deliverable(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.complete_push_notification_attempt(uuid, uuid, text, integer, text) from public, anon, authenticated;

grant execute on function public.register_push_subscription(text, text, text, text, text) to authenticated;
grant execute on function public.disable_push_subscription(uuid) to authenticated;
grant execute on function public.disable_current_push_subscription(text) to authenticated;
grant execute on function public.claim_push_notification_attempt(uuid, uuid, date, text, uuid) to service_role;
grant execute on function public.is_push_notification_attempt_deliverable(uuid, uuid) to service_role;
grant execute on function public.complete_push_notification_attempt(uuid, uuid, text, integer, text) to service_role;
