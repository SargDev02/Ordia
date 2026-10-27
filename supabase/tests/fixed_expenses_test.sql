begin;
select plan(39);

select ok((select relrowsecurity from pg_class where oid = 'public.fixed_expenses'::regclass), 'RLS is enabled on fixed expenses');
select ok((select relrowsecurity from pg_class where oid = 'public.fixed_expense_versions'::regclass), 'RLS is enabled on versions');
select ok((select relrowsecurity from pg_class where oid = 'public.fixed_expense_periods'::regclass), 'RLS is enabled on periods');

select is(public.fixed_expense_due_date('2026-01-31', 'monthly', 1), '2026-02-28'::date, 'January 31 uses February end');
select is(public.fixed_expense_due_date('2026-01-31', 'monthly', 2), '2026-03-31'::date, 'Original day returns after short month');
select is(public.fixed_expense_due_date('2024-02-29', 'annual', 1), '2025-02-28'::date, 'Leap day uses February end');
select is(public.fixed_expense_due_date('2024-02-29', 'annual', 4), '2028-02-29'::date, 'Leap day returns in leap year');

insert into auth.users (id, email) values
  ('41111111-1111-1111-1111-111111111111', 'fixed-a@ordia.test'),
  ('42222222-2222-2222-2222-222222222222', 'fixed-b@ordia.test');

insert into public.financial_accounts (id, user_id, name, account_type, currency, initial_balance) values
  ('4aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '41111111-1111-1111-1111-111111111111', 'A principal', 'bank', 'COP', 1000000),
  ('4bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '42222222-2222-2222-2222-222222222222', 'B principal', 'bank', 'COP', 500000);
insert into public.financial_categories (id, user_id, kind, name) values
  ('4ccccccc-cccc-cccc-cccc-ccccccccccc1', '41111111-1111-1111-1111-111111111111', 'expense', 'Servicios'),
  ('4ddddddd-dddd-dddd-dddd-ddddddddddd1', '42222222-2222-2222-2222-222222222222', 'expense', 'Privada B');

create temporary table fixed_expense_test_clock (today date, first_due date, next_due date, edit_due date);
insert into fixed_expense_test_clock
select today, first_due, next_due, public.fixed_expense_due_date(next_due, 'monthly', 1)
from (
  select today, (today - interval '9 months')::date as first_due, (today + interval '1 month')::date as next_due
  from (select (now() at time zone 'America/Bogota')::date as today) as current_day
) as dates;
grant select on fixed_expense_test_clock to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '41111111-1111-1111-1111-111111111111';

select lives_ok(
  $$ select public.create_fixed_expense(
    '40000000-0000-0000-0000-000000000001', 'Internet', 90000,
    '4ccccccc-cccc-cccc-cccc-ccccccccccc1', '4aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'monthly', (select first_due from fixed_expense_test_clock), 'Plan hogar'
  ) $$,
  'An authenticated user can create a fixed expense'
);

select results_eq(
  $$ select count(*) from public.fixed_expenses where client_request_id = '40000000-0000-0000-0000-000000000001' $$,
  array[1::bigint], 'Create request produces one configuration'
);
select ok((select count(*) from public.fixed_expense_periods) >= 10, 'Generation recovers periods missed during an absence');
select lives_ok($$ select public.generate_fixed_expense_periods(3) $$, 'Period generation can be retried');
select results_eq(
  $$ select count(*) - count(distinct due_date) from public.fixed_expense_periods $$,
  array[0::bigint], 'Retrying generation creates no duplicate due dates'
);
select results_eq($$ select count(*) from public.financial_transactions $$, array[0::bigint], 'Pending obligations do not create expenses');

select throws_ok(
  $$ select public.pay_fixed_expense_period(
    (select id from public.fixed_expense_periods order by due_date limit 1),
    '40000000-0000-0000-0000-000000000002', '4bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    '4ccccccc-cccc-cccc-cccc-ccccccccccc1', (select today from fixed_expense_test_clock), 91000
  ) $$,
  '23503', 'Source account does not exist', 'A payment cannot use another user account'
);
select results_eq(
  $$ select count(*) from public.financial_transactions where client_request_id = '40000000-0000-0000-0000-000000000002' $$,
  array[0::bigint], 'A failed payment leaves no partial movement'
);

select lives_ok(
  $$ select public.pay_fixed_expense_period(
    (select id from public.fixed_expense_periods order by due_date limit 1),
    '40000000-0000-0000-0000-000000000003', '4aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '4ccccccc-cccc-cccc-cccc-ccccccccccc1', (select today from fixed_expense_test_clock), 91000
  ) $$,
  'A late payment is registered atomically'
);
select lives_ok(
  $$ select public.pay_fixed_expense_period(
    (select id from public.fixed_expense_periods order by due_date limit 1),
    '40000000-0000-0000-0000-000000000003', '4aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '4ccccccc-cccc-cccc-cccc-ccccccccccc1', (select today from fixed_expense_test_clock), 91000
  ) $$,
  'Retrying the same payment request is idempotent'
);
select results_eq(
  $$ select count(*) from public.financial_transactions where client_request_id = '40000000-0000-0000-0000-000000000003' $$,
  array[1::bigint], 'Payment retry creates one movement'
);
select ok(
  (select transaction_id is not null and paid_amount = 91000 and paid_on = (select today from fixed_expense_test_clock)
   from public.fixed_expense_periods order by due_date limit 1),
  'The obligation stores the exact linked payment'
);
select is(
  (select due_date from public.fixed_expense_periods order by due_date offset 1 limit 1),
  public.fixed_expense_due_date((select first_due from fixed_expense_test_clock), 'monthly', 1),
  'Paying late does not shift the next due date'
);
select throws_ok(
  $$ select public.pay_fixed_expense_period(
    (select id from public.fixed_expense_periods order by due_date limit 1),
    '40000000-0000-0000-0000-000000000004', '4aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '4ccccccc-cccc-cccc-cccc-ccccccccccc1', (select today from fixed_expense_test_clock), 91000
  ) $$,
  '23505', 'This obligation is already paid', 'A second payment request is rejected'
);
do $$ begin perform set_config('ordia.fixed_payment_flow', 'off', true); end $$;
select throws_ok(
  $$ update public.financial_transactions set amount = 1 where client_request_id = '40000000-0000-0000-0000-000000000003' $$,
  '23514', 'Recurring payments must be changed from the fixed expense flow', 'Linked movements cannot be edited directly'
);
select lives_ok(
  $$ select public.undo_fixed_expense_payment((select id from public.fixed_expense_periods order by due_date limit 1)) $$,
  'A payment can be reversed atomically'
);
select ok(
  (select deleted_at is not null from public.financial_transactions where client_request_id = '40000000-0000-0000-0000-000000000003'),
  'Undo logically deletes the financial movement'
);
select ok(
  (select transaction_id is null and paid_at is null from public.fixed_expense_periods order by due_date limit 1),
  'Undo returns the obligation to pending'
);

select lives_ok(
  $$ select public.pause_fixed_expense((select id from public.fixed_expenses where client_request_id = '40000000-0000-0000-0000-000000000001')) $$,
  'An active recurrence can be paused'
);
select results_eq($$ select status from public.fixed_expenses $$, array['paused'::text], 'Pause changes the configuration status');
select ok(
  exists(select 1 from public.fixed_expense_periods where due_date >= (select today from fixed_expense_test_clock) and cancellation_reason = 'paused'),
  'Pause cancels an upcoming obligation'
);
select ok(
  exists(select 1 from public.fixed_expense_periods where due_date < (select today from fixed_expense_test_clock) and cancelled_at is null),
  'Pause preserves an already overdue obligation'
);

select lives_ok(
  $$ select public.reactivate_fixed_expense(
    (select id from public.fixed_expenses where client_request_id = '40000000-0000-0000-0000-000000000001'),
    (select next_due from fixed_expense_test_clock)
  ) $$,
  'A paused recurrence can be reactivated from an explicit next due date'
);
select results_eq($$ select status from public.fixed_expenses $$, array['active'::text], 'Reactivate restores active status');
select ok(
  exists(select 1 from public.fixed_expense_periods where due_date >= (select today from fixed_expense_test_clock) and due_date < (select next_due from fixed_expense_test_clock) and cancellation_reason = 'paused'),
  'Reactivation does not recreate obligations from the paused gap'
);
select ok(
  (select cancelled_at is null from public.fixed_expense_periods where due_date = (select next_due from fixed_expense_test_clock)),
  'Reactivation creates the requested next obligation'
);

select lives_ok(
  $$ select public.update_fixed_expense(
    (select id from public.fixed_expenses where client_request_id = '40000000-0000-0000-0000-000000000001'),
    'Internet hogar', 100000, '4ccccccc-cccc-cccc-cccc-ccccccccccc1',
    '4aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'monthly',
    (select next_due from fixed_expense_test_clock), (select edit_due from fixed_expense_test_clock), null
  ) $$,
  'Future configuration changes create a new version'
);
select results_eq(
  $$ select expected_amount from public.fixed_expense_periods where due_date < (select today from fixed_expense_test_clock) order by due_date desc limit 1 $$,
  array[90000::bigint], 'Future edits preserve overdue history'
);
select results_eq(
  $$ select expected_amount from public.fixed_expense_periods where due_date = (select edit_due from fixed_expense_test_clock) $$,
  array[100000::bigint], 'Future edits apply from the selected effective due date'
);

set local request.jwt.claim.sub = '42222222-2222-2222-2222-222222222222';
select results_eq($$ select count(*) from public.fixed_expenses $$, array[0::bigint], 'User B cannot see user A configurations');
select results_eq($$ select count(*) from public.fixed_expense_periods $$, array[0::bigint], 'User B cannot see user A obligations');
select throws_ok(
  $$ select public.pay_fixed_expense_period(
    '00000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000005',
    '4bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '4ddddddd-dddd-dddd-dddd-ddddddddddd1', (select today from fixed_expense_test_clock), 1
  ) $$,
  '23503', 'Fixed expense period does not exist', 'User B cannot operate an unavailable user A obligation'
);

select * from finish();
rollback;
