-- PostgreSQL local, simula una app que lleva tiempo cerrada; no envía notificaciones.
begin;
insert into auth.users(id,email) values
 ('be111111-1111-4111-8111-111111111111','cron-a@ordia.test'),
 ('be222222-2222-4222-8222-222222222222','cron-b@ordia.test');
set local role authenticated;
set local request.jwt.claim.sub='be111111-1111-4111-8111-111111111111';
do $$
declare account_id uuid; category_id uuid;
begin
  insert into public.financial_accounts(name,account_type) values('Banco de prueba','bank') returning id into account_id;
  insert into public.financial_categories(name,kind) values('Servicios de prueba','expense') returning id into category_id;
  perform public.create_fixed_expense(gen_random_uuid(),'Servicio de prueba',3000,category_id,account_id,'monthly',(now() at time zone 'America/Bogota')::date,null);
  perform public.register_push_subscription_for_channel('https://web.push.apple.com/cron-a','p256dh-cron-a-valid-key','auth-cron-a-valid-key','Prueba cron A','fixed_expenses','Synthetic');
  begin
    perform public.generate_fixed_expense_periods_for_reminders();
    raise exception 'authenticated pudo generar recordatorios de otros usuarios';
  exception when insufficient_privilege then null; end;
end;
$$;
set local request.jwt.claim.sub='be222222-2222-4222-8222-222222222222';
do $$
declare account_id uuid; category_id uuid;
begin
  insert into public.financial_accounts(name,account_type) values('Banco de prueba','bank') returning id into account_id;
  insert into public.financial_categories(name,kind) values('Servicios de prueba','expense') returning id into category_id;
  perform public.create_fixed_expense(gen_random_uuid(),'Servicio de prueba',3000,category_id,account_id,'monthly',(now() at time zone 'America/Bogota')::date,null);
  perform public.register_push_subscription_for_channel('https://web.push.apple.com/cron-b','p256dh-cron-b-valid-key','auth-cron-b-valid-key','Prueba cron B','bank_movements','Synthetic');
end;
$$;
reset role;
delete from public.fixed_expense_periods where user_id in ('be111111-1111-4111-8111-111111111111','be222222-2222-4222-8222-222222222222');
set local role service_role;
set local request.jwt.claim.sub='';
do $$
declare before_count integer;
begin
  perform public.generate_fixed_expense_periods_for_reminders();
  if not exists(select 1 from public.fixed_expense_periods where user_id='be111111-1111-4111-8111-111111111111' and due_date=(now() at time zone 'America/Bogota')::date)
    or exists(select 1 from public.fixed_expense_periods where user_id='be222222-2222-4222-8222-222222222222') then
    raise exception 'El cron no renovó el horizonte con las preferencias correctas';
  end if;
  select count(*) into before_count from public.fixed_expense_periods;
  perform public.generate_fixed_expense_periods_for_reminders();
  if (select count(*) from public.fixed_expense_periods) <> before_count then raise exception 'Generación repetida duplicó obligaciones'; end if;
  if auth.uid() is not null then raise exception 'No se restauró el contexto de identidad del cron'; end if;
  if exists(select 1 from public.financial_transactions where user_id in ('be111111-1111-4111-8111-111111111111','be222222-2222-4222-8222-222222222222')) then
    raise exception 'Generar obligaciones creó gastos';
  end if;
end;
$$;
rollback;
