begin;
select plan(14);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.financial_accounts'::regclass),
  'RLS is enabled on financial_accounts'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.financial_transactions'::regclass),
  'RLS is enabled on financial_transactions'
);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'finance-a@ordia.test'),
  ('22222222-2222-2222-2222-222222222222', 'finance-b@ordia.test');

insert into public.financial_accounts (id, user_id, name, account_type, currency, initial_balance) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'A principal', 'bank', 'COP', 1000),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', 'A efectivo', 'cash', 'COP', 0),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '22222222-2222-2222-2222-222222222222', 'B principal', 'bank', 'COP', 500);

insert into public.financial_categories (id, user_id, kind, name) values
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', '11111111-1111-1111-1111-111111111111', 'income', 'Salario'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc2', '11111111-1111-1111-1111-111111111111', 'expense', 'Alimentación'),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd1', '22222222-2222-2222-2222-222222222222', 'income', 'Salario');

set local role authenticated;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

select results_eq(
  $$ select count(*) from public.financial_accounts $$,
  array[2::bigint],
  'User A sees only their accounts'
);

select lives_ok(
  $$ insert into public.financial_accounts (name, account_type, currency, initial_balance)
     values ('A wallet', 'wallet', 'COP', 0) $$,
  'User A can create an own account with zero balance'
);

select throws_ok(
  $$ insert into public.financial_accounts (user_id, name, account_type, currency, initial_balance)
     values ('22222222-2222-2222-2222-222222222222', 'Foreign', 'cash', 'COP', 0) $$,
  '42501',
  null,
  'User A cannot create an account for User B'
);

select lives_ok(
  $$ select public.create_financial_transaction(
      '33333333-3333-3333-3333-333333333331', 'income',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', null, 300, '2026-10-15', 'cccccccc-cccc-cccc-cccc-ccccccccccc1', 'Salary'
    ) $$,
  'User A can create an income'
);

select lives_ok(
  $$ select public.create_financial_transaction(
      '33333333-3333-3333-3333-333333333331', 'income',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', null, 300, '2026-10-15', 'cccccccc-cccc-cccc-cccc-ccccccccccc1', 'Salary'
    ) $$,
  'Retrying the same request is idempotent'
);

select results_eq(
  $$ select count(*) from public.financial_transactions
     where client_request_id = '33333333-3333-3333-3333-333333333331' $$,
  array[1::bigint],
  'Idempotent retry creates one row'
);

select throws_ok(
  $$ select public.create_financial_transaction(
      '33333333-3333-3333-3333-333333333332', 'transfer',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 100, '2026-10-15', null, null
    ) $$,
  '23503',
  'Destination account does not exist',
  'A transfer cannot reference another user account'
);

select results_eq(
  $$ select count(*) from public.financial_transactions
     where client_request_id = '33333333-3333-3333-3333-333333333332' $$,
  array[0::bigint],
  'A failed transfer leaves no partial row'
);

select throws_ok(
  $$ select public.create_financial_transaction(
      '33333333-3333-3333-3333-333333333333', 'transfer',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 100, '2026-10-15', null, null
    ) $$,
  '23514',
  'Transfer accounts must be different',
  'A transfer requires different accounts'
);

update public.financial_accounts
set archived_at = now()
where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';

select throws_ok(
  $$ select public.create_financial_transaction(
      '33333333-3333-3333-3333-333333333334', 'expense',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', null, 50, '2026-10-15', 'cccccccc-cccc-cccc-cccc-ccccccccccc2', null
    ) $$,
  '23514',
  'Archived accounts do not accept new transactions',
  'Archived accounts reject new transactions'
);

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

select results_eq(
  $$ select count(*) from public.financial_accounts $$,
  array[1::bigint],
  'User B sees only their account'
);

select results_eq(
  $$ select count(*) from public.financial_transactions $$,
  array[0::bigint],
  'User B sees none of User A transactions'
);

select * from finish();
rollback;
