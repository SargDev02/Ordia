-- Diagnóstico privado de códigos, sin cuerpos, remitentes, tokens ni endpoints.
create table private.bank_email_diagnostics (
  event_hash text not null check (event_hash ~ '^[a-f0-9]{64}$'),
  stage text not null check (stage in ('classification','ingest','push')),
  outcome text not null check (outcome in (
    'unverified_sender','failed_email_authentication','unrecognized_content','invalid_amount_or_ambiguous',
    'created','duplicate','ingest_failed','alias_not_found','alias_inactive','subscription_lookup_failed','no_enabled_devices',
    'push_failed','subscription_invalid','provider_accepted','state_changed','push_retry_unavailable')),
  user_id uuid references auth.users(id) on delete cascade,
  observed_count integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key(event_hash,stage)
);
create index bank_email_diagnostics_retention_idx on private.bank_email_diagnostics(last_seen_at);
alter table private.bank_email_diagnostics enable row level security;
revoke all on private.bank_email_diagnostics from public,anon,authenticated;
grant all on private.bank_email_diagnostics to service_role;
create function public.record_bank_email_diagnostic(p_event_hash text,p_alias_local_part text,p_stage text,p_outcome text)
returns void language plpgsql security invoker set search_path='' as $$
begin
  delete from private.bank_email_diagnostics where last_seen_at < now()-interval '30 days';
  insert into private.bank_email_diagnostics(event_hash,stage,outcome,user_id)
  values(p_event_hash,p_stage,p_outcome,(select user_id from public.bank_email_aliases where alias_local_part=p_alias_local_part))
  on conflict(event_hash,stage) do update set outcome=excluded.outcome,
    observed_count=private.bank_email_diagnostics.observed_count+1,last_seen_at=now();
end;
$$;
revoke all on function public.record_bank_email_diagnostic(text,text,text,text) from public,anon,authenticated;
grant execute on function public.record_bank_email_diagnostic(text,text,text,text) to service_role;

-- Reservar dispositivos habilitados EN LA RECEPCIÓN: activar un canal después no crea avisos retrospectivos.
alter table public.bank_push_notification_attempts
  drop constraint bank_push_notification_attempts_status_check,
  drop constraint bank_push_notification_attempts_attempt_count_check,
  add constraint bank_push_notification_attempts_status_check check(status in ('queued','processing','sent','failed','invalid','skipped')),
  add constraint bank_push_notification_attempts_attempt_count_check check(attempt_count between 0 and 3);
create function private.queue_bank_push_at_receipt() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.delivery_kind='bank_notification' and new.bank_notification_id is not null then
    insert into public.bank_push_notification_attempts(user_id,subscription_id,bank_notification_id,status,attempt_count,run_id)
    select s.user_id,s.id,n.id,'queued',0,gen_random_uuid()
    from public.push_subscriptions s join public.bank_notifications n on n.user_id=s.user_id
    where n.id=new.bank_notification_id and n.user_id=new.user_id and n.source_channel='gmail' and n.status='pending'
      and s.active and s.notify_bank_movements
    on conflict(subscription_id,bank_notification_id) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.queue_bank_push_at_receipt() from public,anon,authenticated;
create trigger bank_email_queue_push after insert on private.bank_inbound_email_deliveries
for each row execute function private.queue_bank_push_at_receipt();

-- Tres intentos, pausa mínima de un minuto y recuperación de leases de 20 minutos; caduca a las 24 horas.
create or replace function public.claim_bank_push_notification_attempt(p_subscription_id uuid,p_bank_notification_id uuid,p_run_id uuid)
returns uuid language plpgsql security invoker set search_path='' as $$
declare claimed uuid;
begin
  update public.bank_push_notification_attempts a set status='processing',run_id=p_run_id,
    attempt_count=a.attempt_count+1,http_status=null,error_code=null,attempted_at=now(),completed_at=null,updated_at=now()
  from public.push_subscriptions s, public.bank_notifications n
  where a.subscription_id=p_subscription_id and a.bank_notification_id=p_bank_notification_id
    and s.id=a.subscription_id and n.id=a.bank_notification_id and a.user_id=s.user_id and n.user_id=s.user_id
    and s.active and s.notify_bank_movements and n.source_channel='gmail' and n.status='pending'
    and a.created_at>now()-interval '24 hours' and a.attempt_count<3
    and (a.status='queued'
      or (a.status='failed' and (a.http_status is null or a.http_status=429 or a.http_status>=500) and a.attempted_at<now()-interval '1 minute')
      or (a.status='processing' and a.attempted_at<now()-interval '20 minutes'))
  returning a.id into claimed;
  return claimed;
end;
$$;
revoke all on function public.claim_bank_push_notification_attempt(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_bank_push_notification_attempt(uuid,uuid,uuid) to service_role;

create index bank_push_recovery_idx on public.bank_push_notification_attempts(status,attempted_at)
  where status in ('queued','failed','processing');
create function public.list_bank_push_retry_targets(p_notification_id uuid default null,p_limit integer default 100)
returns table(id uuid,user_id uuid,endpoint text,p256dh text,auth text,bank_notification_id uuid)
language sql security invoker set search_path='' as $$
  select s.id,s.user_id,s.endpoint,s.p256dh,s.auth,n.id
  from public.bank_push_notification_attempts a
  join public.push_subscriptions s on s.id=a.subscription_id and s.user_id=a.user_id
  join public.bank_notifications n on n.id=a.bank_notification_id and n.user_id=a.user_id
  where s.active and s.notify_bank_movements and n.status='pending' and n.source_channel='gmail'
    and (p_notification_id is null or n.id=p_notification_id)
    and a.created_at>now()-interval '24 hours' and a.attempt_count<3
    and (a.status='queued'
      or (a.status='failed' and (a.http_status is null or a.http_status=429 or a.http_status>=500) and a.attempted_at<now()-interval '1 minute')
      or (a.status='processing' and a.attempted_at<now()-interval '20 minutes'))
  order by a.attempted_at,a.id limit greatest(1,least(coalesce(p_limit,100),500));
$$;
revoke all on function public.list_bank_push_retry_targets(uuid,integer) from public,anon,authenticated;
grant execute on function public.list_bank_push_retry_targets(uuid,integer) to service_role;

-- El horizonte ya no depende de abrir la aplicación. Exclusiva del cron de servidor.
create function public.generate_fixed_expense_periods_for_reminders()
returns integer language plpgsql security invoker set search_path='' as $$
declare
  owner_id uuid;
  original_sub text := current_setting('request.jwt.claim.sub',true);
  total integer := 0;
begin
  for owner_id in
    select distinct f.user_id from public.fixed_expenses f
    join public.push_subscriptions s on s.user_id=f.user_id and s.active and s.notify_fixed_expenses
    where f.status='active'
  loop
    perform set_config('request.jwt.claim.sub',owner_id::text,true);
    total := total + public.generate_fixed_expense_periods(3);
  end loop;
  perform set_config('request.jwt.claim.sub',coalesce(original_sub,''),true);
  return total;
exception when others then
  perform set_config('request.jwt.claim.sub',coalesce(original_sub,''),true);
  raise;
end;
$$;
revoke all on function public.generate_fixed_expense_periods_for_reminders() from public,anon,authenticated;
grant execute on function public.generate_fixed_expense_periods_for_reminders() to service_role;

grant execute on function public.generate_fixed_expense_periods(integer) to service_role;
