begin;
select plan(22);

select ok((select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass), 'RLS is enabled on push subscriptions');
select ok((select relrowsecurity from pg_class where oid = 'public.push_notification_attempts'::regclass), 'RLS is enabled on push attempts');
select has_function('public', 'register_push_subscription', array['text', 'text', 'text', 'text', 'text'], 'Register RPC exists');
select has_function('public', 'claim_push_notification_attempt', array['uuid', 'uuid', 'date', 'text', 'uuid'], 'Claim RPC exists');

insert into auth.users (id, email) values
  ('51111111-1111-1111-1111-111111111111', 'push-a@ordia.test'),
  ('52222222-2222-2222-2222-222222222222', 'push-b@ordia.test');

insert into public.financial_categories (id, user_id, kind, name) values
  ('5ccccccc-cccc-cccc-cccc-ccccccccccc1', '51111111-1111-1111-1111-111111111111', 'expense', 'Servicios');

set local role authenticated;
set local request.jwt.claim.sub = '51111111-1111-1111-1111-111111111111';

select lives_ok(
  $$ select public.register_push_subscription('https://push.test/shared', 'p256dh-a', 'auth-a', 'Equipo A', 'Test') $$,
  'User A can register a device'
);
select results_eq($$ select count(*) from public.push_subscriptions where active $$, array[1::bigint], 'User A sees one active device');
select throws_ok(
  $$ insert into public.push_subscriptions (endpoint, p256dh, auth, device_label) values ('https://push.test/direct', 'key', 'auth', 'Direct') $$,
  '42501', null, 'Direct inserts are not allowed'
);

reset role;
select set_config('ordia.fixed_expense_flow', 'on', true);
insert into public.fixed_expenses (id, user_id, client_request_id, name)
values ('5eeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', '51111111-1111-1111-1111-111111111111', '50000000-0000-0000-0000-000000000001', 'Internet');
insert into public.fixed_expense_versions (
  id, user_id, fixed_expense_id, effective_from, expected_amount, category_id, frequency, anchor_date
) values (
  '5fffffff-ffff-ffff-ffff-fffffffffff1', '51111111-1111-1111-1111-111111111111',
  '5eeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', current_date, 90000,
  '5ccccccc-cccc-cccc-cccc-ccccccccccc1', 'monthly', current_date
);
insert into public.fixed_expense_periods (
  id, user_id, fixed_expense_id, version_id, due_date, expected_amount, category_id
) values
  ('50000000-0000-0000-0000-000000000010', '51111111-1111-1111-1111-111111111111', '5eeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', '5fffffff-ffff-ffff-ffff-fffffffffff1', current_date + 1, 90000, '5ccccccc-cccc-cccc-cccc-ccccccccccc1'),
  ('50000000-0000-0000-0000-000000000011', '51111111-1111-1111-1111-111111111111', '5eeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', '5fffffff-ffff-ffff-ffff-fffffffffff1', current_date - 1, 90000, '5ccccccc-cccc-cccc-cccc-ccccccccccc1');

set local role service_role;
select ok(public.claim_push_notification_attempt(
  (select id from public.push_subscriptions where endpoint = 'https://push.test/shared'),
  '50000000-0000-0000-0000-000000000010', current_date, 'day_before',
  '50000000-0000-0000-0000-000000000020'
) is not null, 'Server claims the day-before reminder');
select ok(public.claim_push_notification_attempt(
  (select id from public.push_subscriptions where endpoint = 'https://push.test/shared'),
  '50000000-0000-0000-0000-000000000010', current_date, 'day_before',
  '50000000-0000-0000-0000-000000000021'
) is null, 'A concurrent claim is rejected');
select ok(public.claim_push_notification_attempt(
  (select id from public.push_subscriptions where endpoint = 'https://push.test/shared'),
  '50000000-0000-0000-0000-000000000011', current_date, 'overdue',
  '50000000-0000-0000-0000-000000000022'
) is not null, 'Server claims an overdue reminder for today');
select results_eq($$ select count(*) from public.push_notification_attempts $$, array[2::bigint], 'Claims create one attempt per rule and day');
select ok(public.is_push_notification_attempt_deliverable(
  (select id from public.push_notification_attempts where fixed_expense_period_id = '50000000-0000-0000-0000-000000000010'),
  '50000000-0000-0000-0000-000000000020'
), 'Pending obligation remains deliverable');

select lives_ok(
  $$ select public.complete_push_notification_attempt(
    (select id from public.push_notification_attempts where fixed_expense_period_id = '50000000-0000-0000-0000-000000000010'),
    '50000000-0000-0000-0000-000000000020', 'sent', 201, null
  ) $$,
  'A successful delivery is recorded'
);
select results_eq($$ select status from public.push_notification_attempts where fixed_expense_period_id = '50000000-0000-0000-0000-000000000010' $$, array['sent'::text], 'Sent status is final');

update public.fixed_expense_periods set cancelled_at = now(), cancellation_reason = 'paused'
where id = '50000000-0000-0000-0000-000000000011';
select ok(not public.is_push_notification_attempt_deliverable(
  (select id from public.push_notification_attempts where fixed_expense_period_id = '50000000-0000-0000-0000-000000000011'),
  '50000000-0000-0000-0000-000000000022'
), 'A paused or cancelled obligation is rechecked before sending');

set local role authenticated;
set local request.jwt.claim.sub = '52222222-2222-2222-2222-222222222222';
select results_eq($$ select count(*) from public.push_subscriptions $$, array[0::bigint], 'User B cannot see user A devices');
select lives_ok(
  $$ select public.register_push_subscription('https://push.test/shared', 'p256dh-b', 'auth-b', 'Equipo B', 'Test') $$,
  'The same browser can be reassigned safely after an account change'
);
select results_eq($$ select count(*) from public.push_subscriptions where active $$, array[1::bigint], 'User B sees only its active registration');

reset role;
select results_eq(
  $$ select disabled_reason from public.push_subscriptions where user_id = '51111111-1111-1111-1111-111111111111' $$,
  array['reassigned'::text], 'Reassignment disables the previous user device row'
);
select results_eq($$ select count(*) from public.push_subscriptions where active $$, array[1::bigint], 'Only one account owns the active endpoint');

set local role service_role;
select lives_ok(
  $$ select public.complete_push_notification_attempt(
    (select id from public.push_notification_attempts where fixed_expense_period_id = '50000000-0000-0000-0000-000000000011'),
    '50000000-0000-0000-0000-000000000022', 'invalid', 410, 'subscription_expired'
  ) $$,
  'An invalid provider response is recorded'
);
select results_eq(
  $$ select count(*) from public.push_subscriptions where user_id = '51111111-1111-1111-1111-111111111111' and active $$,
  array[0::bigint], 'An invalid subscription remains disabled'
);

select * from finish();
rollback;
