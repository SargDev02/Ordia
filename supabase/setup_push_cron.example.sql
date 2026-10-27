-- Ejecuta este archivo solo después de desplegar send-push-reminders y crear
-- en Vault los secretos ordia_project_url y ordia_push_cron_secret.
-- No escribas valores secretos en este archivo versionado.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'ordia_project_url') then
    raise exception 'Missing Vault secret: ordia_project_url';
  end if;
  if not exists (select 1 from vault.secrets where name = 'ordia_push_cron_secret') then
    raise exception 'Missing Vault secret: ordia_push_cron_secret';
  end if;
end;
$$;

select cron.schedule(
  'ordia-push-reminders-hourly',
  '0 * * * *',
  $job$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'ordia_project_url'
      ) || '/functions/v1/send-push-reminders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ordia-cron-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'ordia_push_cron_secret'
        )
      ),
      body := jsonb_build_object('scheduled_at', now()),
      timeout_milliseconds := 15000
    ) as request_id;
  $job$
);
