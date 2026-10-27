create or replace function public.fixed_expense_due_date(
  p_anchor_date date,
  p_frequency text,
  p_occurrence integer
)
returns date
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  target_month date;
  last_day date;
  original_day integer := extract(day from p_anchor_date)::integer;
begin
  if p_occurrence < 0 then
    raise exception 'Occurrence must not be negative' using errcode = '22023';
  end if;

  if p_frequency = 'monthly' then
    target_month := (
      make_date(
        extract(year from p_anchor_date)::integer,
        extract(month from p_anchor_date)::integer,
        1
      ) + make_interval(months => p_occurrence)
    )::date;
  elsif p_frequency = 'annual' then
    target_month := make_date(
      extract(year from p_anchor_date)::integer + p_occurrence,
      extract(month from p_anchor_date)::integer,
      1
    );
  else
    raise exception 'Unsupported fixed expense frequency' using errcode = '22023';
  end if;

  last_day := (target_month + interval '1 month - 1 day')::date;
  return make_date(
    extract(year from target_month)::integer,
    extract(month from target_month)::integer,
    least(original_day, extract(day from last_day)::integer)
  );
end;
$$;

create or replace function public.generate_fixed_expense_periods(p_horizon_months integer default 3)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  today date := (now() at time zone 'America/Bogota')::date;
  horizon_date date;
  version_record record;
  due_date_value date;
  inserted_count integer := 0;
  affected integer;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_horizon_months not between 1 and 12 then
    raise exception 'Horizon must be between 1 and 12 months' using errcode = '22023';
  end if;
  horizon_date := (today + make_interval(months => p_horizon_months))::date;
  perform set_config('ordia.fixed_expense_flow', 'on', true);

  for version_record in
    select version.*, (
      select min(next_version.effective_from)
      from public.fixed_expense_versions as next_version
      where next_version.fixed_expense_id = version.fixed_expense_id
        and next_version.superseded_at is null
        and next_version.effective_from > version.effective_from
    ) as next_effective_from
    from public.fixed_expense_versions as version
    join public.fixed_expenses as expense on expense.id = version.fixed_expense_id
    where version.user_id = current_user_id
      and version.superseded_at is null
      and expense.status = 'active'
    order by version.fixed_expense_id, version.effective_from
  loop
    for occurrence in 0..1200 loop
      due_date_value := public.fixed_expense_due_date(version_record.anchor_date, version_record.frequency, occurrence);
      if due_date_value < version_record.effective_from then
        continue;
      end if;
      exit when version_record.next_effective_from is not null and due_date_value >= version_record.next_effective_from;
      exit when due_date_value > horizon_date;

      insert into public.fixed_expense_periods (
        user_id, fixed_expense_id, version_id, due_date, expected_amount,
        currency, category_id, suggested_account_id
      ) values (
        current_user_id, version_record.fixed_expense_id, version_record.id, due_date_value,
        version_record.expected_amount, version_record.currency, version_record.category_id,
        version_record.suggested_account_id
      )
      on conflict (fixed_expense_id, due_date) do update
      set version_id = excluded.version_id,
          expected_amount = excluded.expected_amount,
          currency = excluded.currency,
          category_id = excluded.category_id,
          suggested_account_id = excluded.suggested_account_id,
          cancelled_at = null,
          cancellation_reason = null
      where fixed_expense_periods.cancellation_reason = 'superseded'
        and fixed_expense_periods.transaction_id is null;
      get diagnostics affected = row_count;
      inserted_count := inserted_count + affected;
    end loop;
  end loop;
  return inserted_count;
end;
$$;
