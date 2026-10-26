begin;
select plan(15);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.financial_categories'::regclass),
  'RLS is enabled on financial_categories'
);

insert into auth.users (id, email) values
  ('31111111-1111-1111-1111-111111111111', 'categories-a@ordia.test'),
  ('32222222-2222-2222-2222-222222222222', 'categories-b@ordia.test');

insert into public.financial_categories (id, user_id, kind, name) values
  ('3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '31111111-1111-1111-1111-111111111111', 'expense', 'Comida'),
  ('3bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '32222222-2222-2222-2222-222222222222', 'expense', 'Privada B');

set local role authenticated;
set local request.jwt.claim.sub = '31111111-1111-1111-1111-111111111111';

select results_eq(
  $$ select count(*) from public.financial_categories $$,
  array[1::bigint],
  'User A sees only their categories'
);

select lives_ok(
  $$ insert into public.financial_categories (id, kind, parent_id, name)
     values ('3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'expense', '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'Restaurantes') $$,
  'User A can create a subcategory'
);

select throws_ok(
  $$ insert into public.financial_categories (kind, parent_id, name)
     values ('expense', '3bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'Intrusa') $$,
  '23503',
  'Parent category does not exist',
  'A category cannot use another user parent'
);

select throws_ok(
  $$ insert into public.financial_categories (kind, parent_id, name)
     values ('income', '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'Tipo incorrecto') $$,
  '23514',
  'Parent and child categories must have the same type',
  'Parent and child types must match'
);

select throws_ok(
  $$ insert into public.financial_categories (kind, parent_id, name)
     values ('expense', '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', 'Tercer nivel') $$,
  '23514',
  'Financial categories support only two levels',
  'A third category level is rejected'
);

select throws_ok(
  $$ insert into public.financial_categories (kind, name) values ('expense', ' comida ') $$,
  '23505',
  null,
  'Root names are unique ignoring case and trim'
);

select lives_ok(
  $$ update public.financial_categories set name = 'Comidas' where id = '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' $$,
  'A category can be renamed without changing its id'
);

select results_eq(
  $$ select name from public.financial_categories where id = '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' $$,
  array['Comidas'::text],
  'Rename keeps the stable category reference'
);

select lives_ok(
  $$ update public.financial_categories set archived_at = now() where id = '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' $$,
  'A parent category can be archived'
);

select results_eq(
  $$ select count(*) from public.financial_categories
     where id in ('3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2')
       and archived_at is not null $$,
  array[2::bigint],
  'Archiving a parent also archives its children'
);

select throws_ok(
  $$ insert into public.financial_categories (kind, parent_id, name)
     values ('expense', '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'Nueva hija') $$,
  '23514',
  'Archived categories cannot receive new subcategories',
  'Archived parents reject new children'
);

select throws_ok(
  $$ update public.financial_categories set user_id = '32222222-2222-2222-2222-222222222222'
     where id = '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2' $$,
  '23514',
  'Category identity, owner, type, parent and creation date are immutable',
  'Category ownership cannot change'
);

set local request.jwt.claim.sub = '32222222-2222-2222-2222-222222222222';

select results_eq(
  $$ select count(*) from public.financial_categories $$,
  array[1::bigint],
  'User B sees none of User A categories'
);

select results_eq(
  $$ select count(*) from public.financial_categories where id = '3aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2' $$,
  array[0::bigint],
  'User B cannot read an A subcategory'
);

select * from finish();
rollback;
