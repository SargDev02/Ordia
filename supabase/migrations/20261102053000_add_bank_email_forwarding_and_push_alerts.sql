-- Migración: Recepción automática de avisos bancarios por correo reenviado y preferencia independiente de Web Push
-- Proyecto Ordia
--
-- Incluye:
-- 1. Alias privados e intransferibles por usuario (`public.bank_email_aliases`) con estados
--    `pending_confirmation`, `active` y `disabled`, protegidos con RLS de solo lectura para el propietario
--    y mutación exclusiva mediante RPC autenticadas o `service_role`.
-- 2. Registro privado de entregas procesadas (`private.bank_inbound_email_deliveries`) con hashes SHA-256
--    (sin almacenar cuerpos de correo, códigos ni direcciones privadas) para garantizar idempotencia ante
--    reintentos del proveedor sin descartar dos operaciones legítimas parecidas.
-- 3. Preferencias independientes por canal en `public.push_subscriptions` (`notify_fixed_expenses` y
--    `notify_bank_movements`) para que desactivar avisos bancarios nunca desactive recordatorios de gastos fijos.
-- 4. Registro e idempotencia de intentos Web Push para pendientes automáticos (`public.bank_push_notification_attempts`).

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- =========================================================================
-- 1. Alias de recepción de correo bancario por usuario
-- =========================================================================

create table if not exists public.bank_email_aliases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  alias_local_part text not null check (alias_local_part ~ '^bnc_[a-f0-9]{32}$'),
  status text not null check (status in ('pending_confirmation', 'active', 'disabled')),
  is_current boolean not null default true,
  confirmation_code text check (confirmation_code is null or confirmation_code ~ '^[0-9]{6,12}$'),
  confirmation_url text check (
    confirmation_url is null
    or (
      char_length(confirmation_url) <= 2048
      and confirmation_url ~ '^https://(mail|isolated\.mail)\.google\.com/mail/'
    )
  ),
  confirmation_received_at timestamptz,
  confirmed_at timestamptz,
  first_notification_at timestamptz,
  last_notification_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null or disabled_reason in ('user', 'replaced')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_email_aliases_local_part_unique unique (alias_local_part),
  constraint bank_email_aliases_state_check check (
    (
      status = 'pending_confirmation'
      and is_current
      and confirmed_at is null
      and first_notification_at is null
      and disabled_at is null
      and disabled_reason is null
    )
    or (
      status = 'active'
      and is_current
      and confirmed_at is not null
      and disabled_at is null
      and disabled_reason is null
      and confirmation_code is null
      and confirmation_url is null
    )
    or (
      status = 'disabled'
      and disabled_at is not null
      and disabled_reason is not null
      and confirmation_code is null
      and confirmation_url is null
    )
  )
);

create unique index if not exists bank_email_aliases_one_current_per_user_idx
on public.bank_email_aliases (user_id)
where is_current;

create index if not exists bank_email_aliases_user_created_idx
on public.bank_email_aliases (user_id, created_at desc);

alter table public.bank_email_aliases enable row level security;
revoke all on table public.bank_email_aliases from anon, public, authenticated;
grant select on table public.bank_email_aliases to authenticated;
grant all on table public.bank_email_aliases to service_role;

create policy "Users select own bank email aliases"
on public.bank_email_aliases for select
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.validate_bank_email_alias()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
    or current_setting('ordia.bank_email_flow', true) is distinct from 'on'
  then
    raise exception 'Las direcciones de recepción deben gestionarse mediante las operaciones de Ordia' using errcode = '42501';
  end if;

  new.alias_local_part := lower(btrim(new.alias_local_part));

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.alias_local_part is distinct from old.alias_local_part
      or new.created_at is distinct from old.created_at
    then
      raise exception 'La identidad y el propietario de la dirección de recepción son inmutables' using errcode = '23514';
    end if;

    if old.status = 'disabled' and new.status <> 'disabled' then
      raise exception 'Una dirección de recepción desactivada no puede reactivarse' using errcode = '23514';
    end if;

    new.updated_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists validate_bank_email_alias_trigger on public.bank_email_aliases;
create trigger validate_bank_email_alias_trigger
before insert or update on public.bank_email_aliases
for each row execute function public.validate_bank_email_alias();

revoke all on function public.validate_bank_email_alias() from public, anon, authenticated;

-- =========================================================================
-- 2. Registro privado de entregas entrantes (solo hashes, sin PII ni cuerpo)
-- =========================================================================

create table if not exists private.bank_inbound_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  provider_event_hash text not null check (provider_event_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  alias_id uuid not null references public.bank_email_aliases (id) on delete cascade,
  message_id_hash text check (message_id_hash is null or message_id_hash ~ '^[a-f0-9]{64}$'),
  delivery_kind text not null check (delivery_kind in ('gmail_confirmation', 'bank_notification')),
  bank_notification_id uuid references public.bank_notifications (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint bank_inbound_email_deliveries_event_unique unique (provider_event_hash)
);

create unique index if not exists bank_inbound_email_deliveries_user_message_idx
on private.bank_inbound_email_deliveries (user_id, message_id_hash)
where message_id_hash is not null;

alter table private.bank_inbound_email_deliveries enable row level security;
revoke all on table private.bank_inbound_email_deliveries from anon, public, authenticated;
grant all on table private.bank_inbound_email_deliveries to service_role;

-- =========================================================================
-- 3. Preferencias independientes por canal en Web Push e intentos bancarios
-- =========================================================================

alter table public.push_subscriptions
  add column if not exists notify_fixed_expenses boolean not null default true,
  add column if not exists notify_bank_movements boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'push_subscriptions_active_channel_check'
      and conrelid = 'public.push_subscriptions'::regclass
  ) then
    alter table public.push_subscriptions
      add constraint push_subscriptions_active_channel_check check (
        not active or notify_fixed_expenses or notify_bank_movements
      );
  end if;
end;
$$;

create table if not exists public.bank_push_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions (id) on delete cascade,
  bank_notification_id uuid not null references public.bank_notifications (id) on delete cascade,
  status text not null default 'processing' check (status in ('processing', 'sent', 'failed', 'invalid', 'skipped')),
  run_id uuid not null,
  attempt_count integer not null default 1 check (attempt_count between 1 and 3),
  http_status integer check (http_status is null or http_status between 100 and 599),
  error_code text check (error_code is null or char_length(error_code) <= 120),
  attempted_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bank_push_notification_attempts_unique unique (subscription_id, bank_notification_id)
);

create index if not exists bank_push_notification_attempts_user_idx
on public.bank_push_notification_attempts (user_id, created_at desc);

alter table public.bank_push_notification_attempts enable row level security;
revoke all on table public.bank_push_notification_attempts from anon, public, authenticated;
grant select on table public.bank_push_notification_attempts to authenticated;
grant all on table public.bank_push_notification_attempts to service_role;

create policy "Users select own bank push attempts"
on public.bank_push_notification_attempts for select
to authenticated
using ((select auth.uid()) = user_id);

-- =========================================================================
-- 4. RPC autenticadas de gestión de alias bancarios
-- =========================================================================

create or replace function private.generate_bank_email_local_part()
returns text
language sql
volatile
set search_path = ''
as $$
  select
    'bnc_'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
    || substr(replace(gen_random_uuid()::text, '-', ''), 21, 12)
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
$$;

revoke all on function private.generate_bank_email_local_part() from public, anon, authenticated;

create or replace function private.ensure_or_replace_bank_email_alias(
  p_replace boolean default false
)
returns public.bank_email_aliases
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_alias public.bank_email_aliases;
  result public.bank_email_aliases;
  candidate_local_part text;
  attempt integer := 0;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  -- Serializar por usuario para evitar condiciones de carrera al crear o reemplazar alias
  perform pg_advisory_xact_lock(hashtextextended('bank_email_alias:' || current_user_id::text, 0));

  select * into existing_alias
  from public.bank_email_aliases
  where user_id = current_user_id and is_current
  for update;

  if found then
    if not coalesce(p_replace, false) and existing_alias.status in ('pending_confirmation', 'active') then
      return existing_alias;
    end if;

    perform set_config('ordia.bank_email_flow', 'on', true);

    update public.bank_email_aliases
    set status = 'disabled',
        is_current = false,
        disabled_at = coalesce(disabled_at, now()),
        disabled_reason = case
          when status = 'disabled' then coalesce(disabled_reason, 'replaced')
          else 'replaced'
        end,
        confirmation_code = null,
        confirmation_url = null
    where id = existing_alias.id and user_id = current_user_id;

    perform set_config('ordia.bank_email_flow', 'off', true);
  end if;

  loop
    attempt := attempt + 1;
    if attempt > 5 then
      raise exception 'No pudimos generar una dirección única en este momento' using errcode = '53000';
    end if;

    candidate_local_part := private.generate_bank_email_local_part();

    perform set_config('ordia.bank_email_flow', 'on', true);

    insert into public.bank_email_aliases (
      user_id,
      alias_local_part,
      status,
      is_current
    ) values (
      current_user_id,
      candidate_local_part,
      'pending_confirmation',
      true
    )
    on conflict (alias_local_part) do nothing
    returning * into result;

    perform set_config('ordia.bank_email_flow', 'off', true);

    exit when result.id is not null;
  end loop;

  return result;
end;
$$;

create or replace function private.confirm_bank_email_alias(
  p_alias_id uuid
)
returns public.bank_email_aliases
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  alias_record public.bank_email_aliases;
  result public.bank_email_aliases;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select * into alias_record
  from public.bank_email_aliases
  where id = p_alias_id and user_id = current_user_id
  for update;

  if not found then
    raise exception 'La dirección de recepción no existe' using errcode = '23503';
  end if;

  if not alias_record.is_current or alias_record.status = 'disabled' then
    raise exception 'Esta dirección fue desactivada o reemplazada' using errcode = '23514';
  end if;

  if alias_record.status = 'active' then
    return alias_record;
  end if;

  if alias_record.confirmation_received_at is null then
    raise exception 'Aún no hemos recibido el correo de confirmación de Gmail para esta dirección' using errcode = '23514';
  end if;

  perform set_config('ordia.bank_email_flow', 'on', true);

  update public.bank_email_aliases
  set status = 'active',
      confirmed_at = coalesce(confirmed_at, now()),
      confirmation_code = null,
      confirmation_url = null
  where id = alias_record.id and user_id = current_user_id
  returning * into result;

  perform set_config('ordia.bank_email_flow', 'off', true);

  return result;
end;
$$;

create or replace function private.disable_bank_email_alias(
  p_alias_id uuid
)
returns public.bank_email_aliases
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  alias_record public.bank_email_aliases;
  result public.bank_email_aliases;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select * into alias_record
  from public.bank_email_aliases
  where id = p_alias_id and user_id = current_user_id
  for update;

  if not found then
    raise exception 'La dirección de recepción no existe' using errcode = '23503';
  end if;

  if alias_record.status = 'disabled' then
    return alias_record;
  end if;

  perform set_config('ordia.bank_email_flow', 'on', true);

  update public.bank_email_aliases
  set status = 'disabled',
      disabled_at = coalesce(disabled_at, now()),
      disabled_reason = 'user',
      confirmation_code = null,
      confirmation_url = null
  where id = alias_record.id and user_id = current_user_id
  returning * into result;

  perform set_config('ordia.bank_email_flow', 'off', true);

  return result;
end;
$$;

create or replace function public.ensure_or_replace_bank_email_alias(
  p_replace boolean default false
)
returns public.bank_email_aliases
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.ensure_or_replace_bank_email_alias(p_replace);
$$;

create or replace function public.confirm_bank_email_alias(
  p_alias_id uuid
)
returns public.bank_email_aliases
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.confirm_bank_email_alias(p_alias_id);
$$;

create or replace function public.disable_bank_email_alias(
  p_alias_id uuid
)
returns public.bank_email_aliases
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.disable_bank_email_alias(p_alias_id);
$$;

revoke all on function private.ensure_or_replace_bank_email_alias(boolean) from public, anon;
revoke all on function private.confirm_bank_email_alias(uuid) from public, anon;
revoke all on function private.disable_bank_email_alias(uuid) from public, anon;

grant execute on function private.ensure_or_replace_bank_email_alias(boolean) to authenticated;
grant execute on function private.confirm_bank_email_alias(uuid) to authenticated;
grant execute on function private.disable_bank_email_alias(uuid) to authenticated;

revoke all on function public.ensure_or_replace_bank_email_alias(boolean) from public, anon;
revoke all on function public.confirm_bank_email_alias(uuid) from public, anon;
revoke all on function public.disable_bank_email_alias(uuid) from public, anon;

grant execute on function public.ensure_or_replace_bank_email_alias(boolean) to authenticated;
grant execute on function public.confirm_bank_email_alias(uuid) to authenticated;
grant execute on function public.disable_bank_email_alias(uuid) to authenticated;

-- =========================================================================
-- 5. RPC autenticadas de canales independientes de notificaciones push
-- =========================================================================

create or replace function private.register_push_subscription_for_channel(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device_label text,
  p_channel text default 'fixed_expenses',
  p_user_agent text default null
)
returns public.push_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  enable_fixed boolean;
  enable_bank boolean;
  result public.push_subscriptions;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if p_channel not in ('fixed_expenses', 'bank_movements') then
    raise exception 'Invalid notification channel' using errcode = '22023';
  end if;

  if char_length(p_endpoint) not between 1 and 2048
    or char_length(p_p256dh) not between 1 and 512
    or char_length(p_auth) not between 1 and 512
    or char_length(btrim(p_device_label)) not between 1 and 80
  then
    raise exception 'Invalid push subscription' using errcode = '22023';
  end if;

  enable_fixed := (p_channel = 'fixed_expenses');
  enable_bank := (p_channel = 'bank_movements');

  update public.push_subscriptions
  set active = false,
      disabled_at = now(),
      disabled_reason = 'reassigned',
      updated_at = now()
  where endpoint = p_endpoint and active and user_id <> current_user_id;

  insert into public.push_subscriptions (
    user_id,
    endpoint,
    p256dh,
    auth,
    device_label,
    user_agent,
    active,
    notify_fixed_expenses,
    notify_bank_movements
  ) values (
    current_user_id,
    p_endpoint,
    p_p256dh,
    p_auth,
    btrim(p_device_label),
    nullif(left(p_user_agent, 500), ''),
    true,
    enable_fixed,
    enable_bank
  )
  on conflict (user_id, endpoint) do update
  set p256dh = excluded.p256dh,
      auth = excluded.auth,
      device_label = excluded.device_label,
      user_agent = excluded.user_agent,
      notify_fixed_expenses = case
        when enable_fixed then true
        when public.push_subscriptions.active then public.push_subscriptions.notify_fixed_expenses
        else false
      end,
      notify_bank_movements = case
        when enable_bank then true
        when public.push_subscriptions.active then public.push_subscriptions.notify_bank_movements
        else false
      end,
      active = true,
      disabled_at = null,
      disabled_reason = null,
      last_seen_at = now(),
      updated_at = now()
  returning * into result;

  return result;
end;
$$;

-- Mantener compatibilidad exacta de register_push_subscription (canal gastos fijos) preservando notify_bank_movements si ya estaba activo
create or replace function private.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device_label text,
  p_user_agent text default null
)
returns public.push_subscriptions
language sql
volatile
security definer
set search_path = ''
as $$
  select private.register_push_subscription_for_channel(
    p_endpoint,
    p_p256dh,
    p_auth,
    p_device_label,
    'fixed_expenses',
    p_user_agent
  );
$$;

create or replace function private.set_push_channel_preference(
  p_subscription_id uuid,
  p_channel text,
  p_enabled boolean
)
returns public.push_subscriptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_sub public.push_subscriptions;
  next_fixed boolean;
  next_bank boolean;
  next_active boolean;
  result public.push_subscriptions;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if p_channel not in ('fixed_expenses', 'bank_movements') or p_enabled is null then
    raise exception 'Invalid notification channel preference' using errcode = '22023';
  end if;

  select * into existing_sub
  from public.push_subscriptions
  where id = p_subscription_id and user_id = current_user_id
  for update;

  if not found then
    raise exception 'Push subscription does not exist' using errcode = '23503';
  end if;

  next_fixed := case
    when p_channel = 'fixed_expenses' then p_enabled
    when existing_sub.active then existing_sub.notify_fixed_expenses
    else false
  end;

  next_bank := case
    when p_channel = 'bank_movements' then p_enabled
    when existing_sub.active then existing_sub.notify_bank_movements
    else false
  end;

  next_active := (next_fixed or next_bank);

  if next_active and not existing_sub.active then
    update public.push_subscriptions
    set active = false,
        disabled_at = now(),
        disabled_reason = 'reassigned',
        updated_at = now()
    where endpoint = existing_sub.endpoint and active and user_id <> current_user_id;
  end if;

  update public.push_subscriptions
  set notify_fixed_expenses = next_fixed,
      notify_bank_movements = next_bank,
      active = next_active,
      disabled_at = case when next_active then null else coalesce(disabled_at, now()) end,
      disabled_reason = case when next_active then null else 'user' end,
      last_seen_at = now(),
      updated_at = now()
  where id = existing_sub.id and user_id = current_user_id
  returning * into result;

  return result;
end;
$$;

create or replace function public.register_push_subscription_for_channel(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device_label text,
  p_channel text default 'fixed_expenses',
  p_user_agent text default null
)
returns public.push_subscriptions
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.register_push_subscription_for_channel(
    p_endpoint,
    p_p256dh,
    p_auth,
    p_device_label,
    p_channel,
    p_user_agent
  );
$$;

create or replace function public.set_push_channel_preference(
  p_subscription_id uuid,
  p_channel text,
  p_enabled boolean
)
returns public.push_subscriptions
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.set_push_channel_preference(
    p_subscription_id,
    p_channel,
    p_enabled
  );
$$;

revoke all on function private.register_push_subscription_for_channel(text, text, text, text, text, text) from public, anon;
revoke all on function private.register_push_subscription(text, text, text, text, text) from public, anon;
revoke all on function private.set_push_channel_preference(uuid, text, boolean) from public, anon;

grant execute on function private.register_push_subscription_for_channel(text, text, text, text, text, text) to authenticated;
grant execute on function private.register_push_subscription(text, text, text, text, text) to authenticated;
grant execute on function private.set_push_channel_preference(uuid, text, boolean) to authenticated;

revoke all on function public.register_push_subscription_for_channel(text, text, text, text, text, text) from public, anon;
revoke all on function public.set_push_channel_preference(uuid, text, boolean) from public, anon;

grant execute on function public.register_push_subscription_for_channel(text, text, text, text, text, text) to authenticated;
grant execute on function public.set_push_channel_preference(uuid, text, boolean) to authenticated;

-- =========================================================================
-- 6. Actualizar RPC de recordatorios de gastos fijos para respetar notify_fixed_expenses
-- =========================================================================

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
    and subscription.notify_fixed_expenses
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
      and subscription.notify_fixed_expenses
      and period.transaction_id is null
      and period.cancelled_at is null
  );
$$;

revoke execute on function public.claim_push_notification_attempt(uuid, uuid, date, text, uuid) from public, anon, authenticated;
revoke execute on function public.is_push_notification_attempt_deliverable(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_push_notification_attempt(uuid, uuid, date, text, uuid) to service_role;
grant execute on function public.is_push_notification_attempt_deliverable(uuid, uuid) to service_role;

-- =========================================================================
-- 7. RPC de servidor (`service_role`) para webhook de correo entrante y Web Push bancario
-- =========================================================================

create or replace function private.record_bank_email_gmail_confirmation(
  p_provider_event_hash text,
  p_alias_local_part text,
  p_message_id_hash text default null,
  p_confirmation_code text default null,
  p_confirmation_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  alias_record public.bank_email_aliases;
  clean_code text := nullif(btrim(p_confirmation_code), '');
  clean_url text := nullif(btrim(p_confirmation_url), '');
  clean_msg_hash text := nullif(lower(btrim(p_message_id_hash)), '');
begin
  if p_provider_event_hash is null or p_provider_event_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid provider event hash' using errcode = '22023';
  end if;

  if clean_code is null and clean_url is null then
    raise exception 'Confirmation code or URL is required' using errcode = '22023';
  end if;

  select * into alias_record
  from public.bank_email_aliases
  where alias_local_part = lower(btrim(p_alias_local_part))
  for update;

  if not found then
    return jsonb_build_object(
      'outcome', 'alias_not_found',
      'updated', false
    );
  end if;

  if not alias_record.is_current or alias_record.status = 'disabled' then
    return jsonb_build_object(
      'outcome', 'alias_inactive',
      'updated', false
    );
  end if;

  if exists (
    select 1
    from private.bank_inbound_email_deliveries d
    where d.provider_event_hash = p_provider_event_hash
       or (clean_msg_hash is not null and d.user_id = alias_record.user_id and d.message_id_hash = clean_msg_hash)
  ) then
    return jsonb_build_object(
      'outcome', 'duplicate',
      'updated', false,
      'user_id', alias_record.user_id
    );
  end if;

  insert into private.bank_inbound_email_deliveries (
    provider_event_hash,
    user_id,
    alias_id,
    message_id_hash,
    delivery_kind,
    bank_notification_id
  ) values (
    p_provider_event_hash,
    alias_record.user_id,
    alias_record.id,
    clean_msg_hash,
    'gmail_confirmation',
    null
  );

  if alias_record.status = 'active' then
    return jsonb_build_object(
      'outcome', 'already_confirmed',
      'updated', false,
      'user_id', alias_record.user_id
    );
  end if;

  perform set_config('ordia.bank_email_flow', 'on', true);

  update public.bank_email_aliases
  set confirmation_code = coalesce(clean_code, confirmation_code),
      confirmation_url = coalesce(clean_url, confirmation_url),
      confirmation_received_at = coalesce(confirmation_received_at, now())
  where id = alias_record.id;

  perform set_config('ordia.bank_email_flow', 'off', true);

  return jsonb_build_object(
    'outcome', 'recorded',
    'updated', true,
    'user_id', alias_record.user_id
  );
end;
$$;

create or replace function public.record_bank_email_gmail_confirmation(
  p_provider_event_hash text,
  p_alias_local_part text,
  p_message_id_hash text default null,
  p_confirmation_code text default null,
  p_confirmation_url text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_bank_email_gmail_confirmation(
    p_provider_event_hash,
    p_alias_local_part,
    p_message_id_hash,
    p_confirmation_code,
    p_confirmation_url
  );
$$;

create or replace function private.ingest_bank_inbound_notification(
  p_provider_event_hash text,
  p_alias_local_part text,
  p_message_id_hash text,
  p_bank_name text,
  p_notification_type text,
  p_amount bigint,
  p_occurred_on date,
  p_occurred_time text,
  p_merchant text default null,
  p_account_last_digits text default null,
  p_card_last_digits text default null,
  p_card_type text default null,
  p_counterparty_name text default null,
  p_counterparty_account_last_digits text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  alias_record public.bank_email_aliases;
  existing_delivery private.bank_inbound_email_deliveries;
  created_notification public.bank_notifications;
  clean_msg_hash text := nullif(lower(btrim(p_message_id_hash)), '');
begin
  if p_provider_event_hash is null or p_provider_event_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid provider event hash' using errcode = '22023';
  end if;

  -- Resolver propietario exclusivamente a partir del destinatario de entrega verificado
  select * into alias_record
  from public.bank_email_aliases
  where alias_local_part = lower(btrim(p_alias_local_part))
  for update;

  if not found then
    return jsonb_build_object(
      'outcome', 'alias_not_found',
      'is_new_notification', false
    );
  end if;

  if not alias_record.is_current or alias_record.status = 'disabled' then
    return jsonb_build_object(
      'outcome', 'alias_inactive',
      'is_new_notification', false
    );
  end if;

  -- Idempotencia ante reintentos del proveedor para el mismo correo (sin descartar operaciones legítimas distintas)
  select * into existing_delivery
  from private.bank_inbound_email_deliveries d
  where d.provider_event_hash = p_provider_event_hash
     or (clean_msg_hash is not null and d.user_id = alias_record.user_id and d.message_id_hash = clean_msg_hash)
  limit 1;

  if found then
    return jsonb_build_object(
      'outcome', 'duplicate',
      'is_new_notification', false,
      'user_id', alias_record.user_id,
      'notification_id', existing_delivery.bank_notification_id
    );
  end if;

  perform set_config('ordia.bank_notification_flow', 'on', true);

  insert into public.bank_notifications (
    user_id,
    client_request_id,
    bank_name,
    source_channel,
    notification_type,
    amount,
    currency,
    occurred_on,
    occurred_time,
    merchant,
    account_last_digits,
    card_last_digits,
    card_type,
    counterparty_name,
    counterparty_account_last_digits,
    status
  ) values (
    alias_record.user_id,
    gen_random_uuid(),
    coalesce(nullif(btrim(p_bank_name), ''), 'Bancolombia'),
    'gmail',
    p_notification_type,
    p_amount,
    'COP',
    p_occurred_on,
    p_occurred_time,
    p_merchant,
    p_account_last_digits,
    p_card_last_digits,
    p_card_type,
    p_counterparty_name,
    p_counterparty_account_last_digits,
    'pending'
  )
  returning * into created_notification;

  perform set_config('ordia.bank_notification_flow', 'off', true);

  insert into private.bank_inbound_email_deliveries (
    provider_event_hash,
    user_id,
    alias_id,
    message_id_hash,
    delivery_kind,
    bank_notification_id
  ) values (
    p_provider_event_hash,
    alias_record.user_id,
    alias_record.id,
    clean_msg_hash,
    'bank_notification',
    created_notification.id
  );

  perform set_config('ordia.bank_email_flow', 'on', true);

  update public.bank_email_aliases
  set status = 'active',
      confirmed_at = coalesce(confirmed_at, now()),
      first_notification_at = coalesce(first_notification_at, now()),
      last_notification_at = now(),
      confirmation_code = null,
      confirmation_url = null
  where id = alias_record.id;

  perform set_config('ordia.bank_email_flow', 'off', true);

  return jsonb_build_object(
    'outcome', 'created',
    'is_new_notification', true,
    'user_id', alias_record.user_id,
    'notification_id', created_notification.id
  );
end;
$$;

create or replace function public.ingest_bank_inbound_notification(
  p_provider_event_hash text,
  p_alias_local_part text,
  p_message_id_hash text,
  p_bank_name text,
  p_notification_type text,
  p_amount bigint,
  p_occurred_on date,
  p_occurred_time text,
  p_merchant text default null,
  p_account_last_digits text default null,
  p_card_last_digits text default null,
  p_card_type text default null,
  p_counterparty_name text default null,
  p_counterparty_account_last_digits text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.ingest_bank_inbound_notification(
    p_provider_event_hash,
    p_alias_local_part,
    p_message_id_hash,
    p_bank_name,
    p_notification_type,
    p_amount,
    p_occurred_on,
    p_occurred_time,
    p_merchant,
    p_account_last_digits,
    p_card_last_digits,
    p_card_type,
    p_counterparty_name,
    p_counterparty_account_last_digits
  );
$$;

create or replace function public.claim_bank_push_notification_attempt(
  p_subscription_id uuid,
  p_bank_notification_id uuid,
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
  insert into public.bank_push_notification_attempts (
    user_id,
    subscription_id,
    bank_notification_id,
    status,
    run_id
  )
  select
    subscription.user_id,
    subscription.id,
    notification.id,
    'processing',
    p_run_id
  from public.push_subscriptions as subscription
  join public.bank_notifications as notification on notification.user_id = subscription.user_id
  where subscription.id = p_subscription_id
    and subscription.active
    and subscription.notify_bank_movements
    and notification.id = p_bank_notification_id
    and notification.status = 'pending'
    and notification.source_channel = 'gmail'
  on conflict (subscription_id, bank_notification_id)
  do update set
    status = 'processing',
    run_id = excluded.run_id,
    attempt_count = public.bank_push_notification_attempts.attempt_count + 1,
    http_status = null,
    error_code = null,
    attempted_at = now(),
    completed_at = null,
    updated_at = now()
  where public.bank_push_notification_attempts.attempt_count < 3
    and (
      public.bank_push_notification_attempts.status = 'failed'
      or (
        public.bank_push_notification_attempts.status = 'processing'
        and public.bank_push_notification_attempts.attempted_at < now() - interval '20 minutes'
      )
    )
  returning id into claimed_id;

  return claimed_id;
end;
$$;

create or replace function public.is_bank_push_notification_attempt_deliverable(
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
    from public.bank_push_notification_attempts as attempt
    join public.push_subscriptions as subscription on subscription.id = attempt.subscription_id
    join public.bank_notifications as notification on notification.id = attempt.bank_notification_id
    where attempt.id = p_attempt_id
      and attempt.run_id = p_run_id
      and attempt.status = 'processing'
      and subscription.active
      and subscription.notify_bank_movements
      and notification.user_id = subscription.user_id
      and notification.status = 'pending'
      and notification.source_channel = 'gmail'
  );
$$;

create or replace function public.complete_bank_push_notification_attempt(
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

  update public.bank_push_notification_attempts
  set status = p_status,
      http_status = p_http_status,
      error_code = nullif(left(p_error_code, 120), ''),
      completed_at = now(),
      updated_at = now()
  where id = p_attempt_id and run_id = p_run_id and status = 'processing'
  returning subscription_id into target_subscription_id;

  if target_subscription_id is null then
    raise exception 'Bank push attempt is no longer claimable' using errcode = '23503';
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

revoke all on function private.record_bank_email_gmail_confirmation(text, text, text, text, text) from public, anon, authenticated;
revoke all on function private.ingest_bank_inbound_notification(text, text, text, text, text, bigint, date, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function private.record_bank_email_gmail_confirmation(text, text, text, text, text) to service_role;
grant execute on function private.ingest_bank_inbound_notification(text, text, text, text, text, bigint, date, text, text, text, text, text, text, text) to service_role;

revoke all on function public.record_bank_email_gmail_confirmation(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.ingest_bank_inbound_notification(text, text, text, text, text, bigint, date, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.claim_bank_push_notification_attempt(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.is_bank_push_notification_attempt_deliverable(uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_bank_push_notification_attempt(uuid, uuid, text, integer, text) from public, anon, authenticated;

grant execute on function public.record_bank_email_gmail_confirmation(text, text, text, text, text) to service_role;
grant execute on function public.ingest_bank_inbound_notification(text, text, text, text, text, bigint, date, text, text, text, text, text, text, text) to service_role;
grant execute on function public.claim_bank_push_notification_attempt(uuid, uuid, uuid) to service_role;
grant execute on function public.is_bank_push_notification_attempt_deliverable(uuid, uuid) to service_role;
grant execute on function public.complete_bank_push_notification_attempt(uuid, uuid, text, integer, text) to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'bank_email_aliases'
    ) then
      alter publication supabase_realtime add table public.bank_email_aliases;
    end if;
  end if;
end;
$$;
