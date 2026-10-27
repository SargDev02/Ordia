create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

alter function public.register_push_subscription(text, text, text, text, text) set schema private;
alter function public.disable_push_subscription(uuid) set schema private;
alter function public.disable_current_push_subscription(text) set schema private;

revoke execute on function private.register_push_subscription(text, text, text, text, text) from public, anon;
revoke execute on function private.disable_push_subscription(uuid) from public, anon;
revoke execute on function private.disable_current_push_subscription(text) from public, anon;
grant execute on function private.register_push_subscription(text, text, text, text, text) to authenticated;
grant execute on function private.disable_push_subscription(uuid) to authenticated;
grant execute on function private.disable_current_push_subscription(text) to authenticated;

create function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_device_label text,
  p_user_agent text default null
)
returns public.push_subscriptions
language sql
security invoker
set search_path = ''
as $$
  select private.register_push_subscription(
    p_endpoint, p_p256dh, p_auth, p_device_label, p_user_agent
  );
$$;

create function public.disable_push_subscription(p_subscription_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.disable_push_subscription(p_subscription_id);
$$;

create function public.disable_current_push_subscription(p_endpoint text)
returns void
language sql
security invoker
set search_path = ''
as $$
  select private.disable_current_push_subscription(p_endpoint);
$$;

revoke execute on function public.register_push_subscription(text, text, text, text, text) from public, anon;
revoke execute on function public.disable_push_subscription(uuid) from public, anon;
revoke execute on function public.disable_current_push_subscription(text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text, text) to authenticated;
grant execute on function public.disable_push_subscription(uuid) to authenticated;
grant execute on function public.disable_current_push_subscription(text) to authenticated;
