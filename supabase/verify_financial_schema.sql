select jsonb_build_object(
  'tables', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', c.relname,
      'rls', c.relrowsecurity,
      'force_rls', c.relforcerowsecurity
    ) order by c.relname), '[]'::jsonb)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in ('financial_accounts', 'financial_transactions')
  ),
  'columns', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', table_name,
      'column', column_name,
      'type', data_type,
      'nullable', is_nullable,
      'default', column_default
    ) order by table_name, ordinal_position), '[]'::jsonb)
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('financial_accounts', 'financial_transactions')
  ),
  'constraints', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', conrelid::regclass::text,
      'name', conname,
      'type', contype,
      'definition', pg_get_constraintdef(oid, true)
    ) order by conrelid::regclass::text, conname), '[]'::jsonb)
    from pg_constraint
    where connamespace = 'public'::regnamespace
      and conrelid in (
        'public.financial_accounts'::regclass,
        'public.financial_transactions'::regclass
      )
  ),
  'policies', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', tablename,
      'name', policyname,
      'command', cmd,
      'roles', roles,
      'using', qual,
      'check', with_check
    ) order by tablename, cmd, policyname), '[]'::jsonb)
    from pg_policies
    where schemaname = 'public'
      and tablename in ('financial_accounts', 'financial_transactions')
  ),
  'grants', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', table_name,
      'role', grantee,
      'privilege', privilege_type
    ) order by table_name, grantee, privilege_type), '[]'::jsonb)
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('financial_accounts', 'financial_transactions')
      and grantee in ('anon', 'authenticated')
  ),
  'publication', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'publication', p.pubname,
      'schema', n.nspname,
      'table', c.relname
    ) order by c.relname), '[]'::jsonb)
    from pg_publication p
    join pg_publication_rel pr on pr.prpubid = p.oid
    join pg_class c on c.oid = pr.prrelid
    join pg_namespace n on n.oid = c.relnamespace
    where p.pubname = 'supabase_realtime'
      and n.nspname = 'public'
      and c.relname in ('financial_accounts', 'financial_transactions')
  ),
  'triggers', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'table', event_object_table,
      'name', trigger_name,
      'event', event_manipulation,
      'timing', action_timing
    ) order by event_object_table, trigger_name, event_manipulation), '[]'::jsonb)
    from information_schema.triggers
    where trigger_schema = 'public'
      and event_object_table in ('financial_accounts', 'financial_transactions')
  )
) as financial_schema;
