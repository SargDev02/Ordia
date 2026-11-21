-- Ordia: menos carga para el plan gratuito (≈10 usuarios).
-- 1) Realtime solo publica los avisos bancarios: son lo único que el servidor crea
--    sin una acción del usuario en la pestaña. El resto de tablas se recarga tras cada
--    mutación y al volver a la pestaña, así que no necesitan replicación lógica.
do $$
declare
  t text;
begin
  foreach t in array array[
    'financial_accounts', 'financial_transactions', 'financial_categories',
    'fixed_expenses', 'fixed_expense_versions', 'fixed_expense_periods',
    'personal_tasks', 'icloud_connections', 'google_connections',
    'task_scheduling_preferences', 'bank_card_account_links', 'bank_email_aliases'
  ] loop
    if exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
    end if;
  end loop;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bank_notifications'
  ) then
    alter publication supabase_realtime add table public.bank_notifications;
  end if;
end;
$$;

-- 2) El historial de pg_cron crece con cada ejecución horaria; se conservan 7 días.
select cron.unschedule(jobid) from cron.job where jobname = 'ordia-prune-cron-history';
select cron.schedule(
  'ordia-prune-cron-history',
  '17 4 * * 0',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$
);
delete from cron.job_run_details where end_time < now() - interval '7 days';
