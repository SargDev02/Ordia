-- Prueba aislada: dos fixtures exclusivos, rol authenticated, ningún service_role.
-- Ejecutar con supabase db query --file, separado de la suite TAP.
-- No llama al job push ni modifica datos existentes. Toda escritura se revierte.
begin;
do $$ begin
  if exists(select 1 from auth.users where id in ('71111111-1111-4111-8111-111111111111', '72222222-2222-4222-8222-222222222222')) then
    raise exception 'Task test fixture already exists; refusing to reuse it';
  end if;
end $$;
insert into auth.users(id, email) values
('71111111-1111-4111-8111-111111111111', 'tasks-fixture-a@ordia.test'),
('72222222-2222-4222-8222-222222222222', 'tasks-fixture-b@ordia.test');

set local role authenticated;
set local request.jwt.claim.sub = '71111111-1111-4111-8111-111111111111';
do $$
declare a public.personal_tasks; b public.personal_tasks; first_completed timestamptz;
begin
  a := public.create_personal_task('70000000-0000-4000-8000-000000000001', '  Leer  ', null, 'medium', null, null, null);
  if a.title <> 'Leer' or a.due_on is not null or a.scheduled_at is not null or a.is_completed then raise exception 'Create without dates failed'; end if;
  b := public.create_personal_task('70000000-0000-4000-8000-000000000001', 'Reintento', null, 'low', 10, null, null);
  if a.id <> b.id or (select count(*) from public.personal_tasks) <> 1 or b.title <> 'Leer' then raise exception 'Idempotency failed'; end if;

  update public.personal_tasks set title='Leer libro', priority='high', estimated_minutes=25,
    due_on='2026-12-31', scheduled_at='2026-12-31 23:30:00-05' where id=a.id returning * into b;
  if b.title <> 'Leer libro' or b.due_on <> date '2026-12-31' or b.scheduled_at <> timestamptz '2027-01-01 04:30:00Z' then raise exception 'Edit/date storage failed'; end if;
  update public.personal_tasks set is_completed=true where id=a.id returning completed_at into first_completed;
  if first_completed is null then raise exception 'Completion timestamp missing'; end if;
  update public.personal_tasks set is_completed=true where id=a.id returning * into b;
  if b.completed_at <> first_completed then raise exception 'Repeated completion changed timestamp'; end if;
  update public.personal_tasks set is_completed=false where id=a.id returning * into b;
  if b.completed_at is not null or b.is_completed then raise exception 'Uncheck failed'; end if;

  begin
    update public.personal_tasks set estimated_minutes=0 where id=a.id;
    raise exception 'TEST FAILED: invalid duration accepted';
  exception when check_violation then null; end;
  begin
    update public.personal_tasks set title='   ' where id=a.id;
    raise exception 'TEST FAILED: empty title accepted';
  exception when check_violation then null; end;
  begin
    update public.personal_tasks set priority='urgent' where id=a.id;
    raise exception 'TEST FAILED: invalid priority accepted';
  exception when check_violation then null; end;
  begin
    update public.personal_tasks set user_id='72222222-2222-4222-8222-222222222222' where id=a.id;
    raise exception 'TEST FAILED: owner changed';
  exception when insufficient_privilege or check_violation then null; end;
  begin
    update public.personal_tasks set completed_at=now() where id=a.id;
    raise exception 'TEST FAILED: forged completion time';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.personal_tasks(user_id, client_request_id, title) values ('72222222-2222-4222-8222-222222222222', gen_random_uuid(), 'forged');
    raise exception 'TEST FAILED: foreign owner inserted';
  exception when insufficient_privilege then null; end;
  begin
    delete from public.personal_tasks where id=a.id;
    raise exception 'TEST FAILED: hard delete allowed';
  exception when insufficient_privilege then null; end;
end $$;

set local request.jwt.claim.sub = '72222222-2222-4222-8222-222222222222';
do $$ declare a public.personal_tasks; affected integer;
begin
  if exists(select 1 from public.personal_tasks) then raise exception 'User B can see A'; end if;
  update public.personal_tasks set title='intrusion' where client_request_id='70000000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'User B can update A'; end if;
  update public.personal_tasks set deleted_at=now() where client_request_id='70000000-0000-4000-8000-000000000001';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'User B can soft delete A'; end if;
  a := public.create_personal_task('70000000-0000-4000-8000-000000000001', 'B', null, 'low', null, null, null);
  if a.user_id <> '72222222-2222-4222-8222-222222222222' then raise exception 'User B owner failed'; end if;
end $$;

set local request.jwt.claim.sub = '71111111-1111-4111-8111-111111111111';
do $$ declare a public.personal_tasks; begin
  if (select count(*) from public.personal_tasks) <> 1 then raise exception 'User A isolation failed'; end if;
  update public.personal_tasks set deleted_at=now() where client_request_id='70000000-0000-4000-8000-000000000001' returning * into a;
  if a.deleted_at is null then raise exception 'Soft delete failed'; end if;
  if exists(select 1 from public.personal_tasks where deleted_at is null) then raise exception 'Deleted task still active'; end if;
  begin
    update public.personal_tasks set deleted_at=null where id=a.id;
    raise exception 'TEST FAILED: deleted task restored';
  exception when check_violation then null; end;
end $$;

reset role;
set local role anon;
do $$ begin
  begin perform 1 from public.personal_tasks; raise exception 'TEST FAILED: anon can select'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS: CRUD, idempotency, completion/uncheck, exact dates, validation, owner immutability, RLS A/B, soft delete, anon denied' as result;
rollback;
