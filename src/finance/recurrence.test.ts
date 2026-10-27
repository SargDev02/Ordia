import { describe, expect, it } from 'vitest'
import { buildFixedExpensePeriodOverviews, buildRecurringDueDates, calculateFixedExpenseSummary, getFixedExpensePeriodState, getMonthBounds, getNextMonthBounds, getRecurringDueDate } from './recurrence'
import type { FixedExpensePeriod } from '../types/finance'

function period(overrides: Partial<FixedExpensePeriod> = {}): FixedExpensePeriod {
  return {
    cancellation_reason: null, cancelled_at: null, category_id: 'category', created_at: '', currency: 'COP',
    due_date: '2026-10-10', expected_amount: 100, fixed_expense_id: 'fixed', id: 'period',
    paid_account_id: null, paid_category_id: null, paid_amount: null, paid_at: null, paid_on: null,
    payment_request_id: null, suggested_account_id: null, transaction_id: null,
    updated_at: '', user_id: 'user', version_id: 'version', ...overrides,
  }
}

describe('recurrencias de gastos fijos', () => {
  it('conserva el día original después de ajustar un fin de mes', () => {
    expect(getRecurringDueDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28')
    expect(getRecurringDueDate('2026-01-31', 'monthly', 2)).toBe('2026-03-31')
  })

  it('aplica la regla del 29 de febrero sin desplazar años posteriores', () => {
    expect(getRecurringDueDate('2024-02-29', 'annual', 1)).toBe('2025-02-28')
    expect(getRecurringDueDate('2024-02-29', 'annual', 4)).toBe('2028-02-29')
  })

  it('recupera todos los períodos omitidos con una secuencia determinista', () => {
    const first = buildRecurringDueDates('2026-01-15', 'monthly', '2026-06-15')
    const retry = buildRecurringDueDates('2026-01-15', 'monthly', '2026-06-15')
    expect(first).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'])
    expect(new Set([...first, ...retry]).size).toBe(first.length)
  })

  it('considera vencido solo lo pendiente anterior al día de Bogotá', () => {
    expect(getFixedExpensePeriodState(period(), '2026-10-11')).toBe('overdue')
    expect(getFixedExpensePeriodState(period({ transaction_id: 'movement' }), '2026-10-11')).toBe('paid')
    expect(getFixedExpensePeriodState(period({ cancelled_at: '2026-10-01T00:00:00Z' }), '2026-10-11')).toBe('cancelled')
  })

  it('pagar tarde no cambia la fecha de la siguiente obligación', () => {
    expect(getRecurringDueDate('2026-01-31', 'monthly', 3)).toBe('2026-04-30')
    expect(getRecurringDueDate('2026-01-31', 'monthly', 4)).toBe('2026-05-31')
  })

  it('prioriza la deuda más antigua y limita los próximos al mes siguiente', () => {
    const periods = [
      period({ id: 'jan', due_date: '2026-01-10' }),
      period({ id: 'feb', due_date: '2026-02-10' }),
      period({ id: 'nov', due_date: '2026-11-10' }),
      period({ id: 'dec', due_date: '2026-12-10' }),
    ]
    const overview = buildFixedExpensePeriodOverviews(periods, '2026-10-26')[0]
    expect(overview.mainPending?.id).toBe('jan')
    expect(overview.nextMonthPending?.id).toBe('nov')
    expect(overview.mainPendingCount).toBe(2)
    expect(overview.overdueCount).toBe(2)
  })

  it('después de pagar el primero presenta el siguiente período pendiente', () => {
    const periods = [
      period({ id: 'first', due_date: '2026-09-10', paid_amount: 100, paid_at: '2026-10-01', paid_on: '2026-10-01', paid_account_id: 'account', paid_category_id: 'category', payment_request_id: 'request', transaction_id: 'movement' }),
      period({ id: 'second', due_date: '2026-10-10' }),
      period({ id: 'third', due_date: '2026-11-10' }),
    ]
    const overview = buildFixedExpensePeriodOverviews(periods, '2026-10-26')[0]
    expect(overview.mainPending?.id).toBe('second')
    expect(overview.mainPendingCount).toBe(1)
    expect(overview.paidCount).toBe(1)
  })

  it('separa pendientes del mes, vencidos, pagos reales del mes y próximo mes', () => {
    const periods = [
      period({ id: 'previous-month', expected_amount: 100, due_date: '2026-09-10', fixed_expense_id: 'a' }),
      period({ id: 'earlier-this-month', expected_amount: 110, due_date: '2026-10-10', fixed_expense_id: 'a' }),
      period({ id: 'today', expected_amount: 120, due_date: '2026-10-26', fixed_expense_id: 'b' }),
      period({ id: 'later-this-month', expected_amount: 200, due_date: '2026-10-30', fixed_expense_id: 'c' }),
      period({ id: 'next-month', expected_amount: 210, due_date: '2026-11-15', fixed_expense_id: 'd' }),
      period({ id: 'late-payment', due_date: '2026-09-15', fixed_expense_id: 'e', paid_amount: 300, paid_at: '2026-10-05T00:00:00Z', paid_on: '2026-10-05', paid_account_id: 'account', paid_category_id: 'category', payment_request_id: 'late', transaction_id: 'late-movement' }),
      period({ id: 'prepaid', due_date: '2026-10-20', fixed_expense_id: 'f', paid_amount: 400, paid_at: '2026-09-25T00:00:00Z', paid_on: '2026-09-25', paid_account_id: 'account', paid_category_id: 'category', payment_request_id: 'early', transaction_id: 'early-movement' }),
    ]
    const summary = calculateFixedExpenseSummary(periods, '2026-10-26')
    expect(summary.pendingThisMonth.map((item) => item.id)).toEqual(['earlier-this-month', 'today', 'later-this-month'])
    expect(summary.pendingThisMonthAmount).toBe(430n)
    expect(summary.overdue.map((item) => item.id)).toEqual(['previous-month', 'earlier-this-month'])
    expect(summary.overdueAmount).toBe(210n)
    expect(summary.nextMonthPending.map((item) => item.id)).toEqual(['next-month'])
    expect(summary.nextMonthPendingAmount).toBe(210n)
    expect(summary.paidThisMonth.map((item) => item.id)).toEqual(['late-payment'])
    expect(summary.paidThisMonthAmount).toBe(300n)
    expect(summary.prepaidDueThisMonth.map((item) => item.id)).toEqual(['prepaid'])
  })

  it('ignora períodos cancelados por pausa o edición y refleja la reactivación vigente', () => {
    const periods = [
      period({ id: 'overdue', due_date: '2026-09-10' }),
      period({ id: 'paused', cancellation_reason: 'paused', cancelled_at: '2026-10-01T00:00:00Z', due_date: '2026-10-10' }),
      period({ id: 'superseded', cancellation_reason: 'superseded', cancelled_at: '2026-10-02T00:00:00Z', due_date: '2026-11-10' }),
      period({ id: 'reactivated', due_date: '2026-12-10' }),
    ]
    const overview = buildFixedExpensePeriodOverviews(periods, '2026-10-26')[0]
    expect(overview.mainPending?.id).toBe('overdue')
    expect(overview.nextMonthPending).toBeNull()
    expect(overview.mainPendingCount).toBe(1)
  })

  it('calcula correctamente el cambio de diciembre a enero', () => {
    expect(getMonthBounds('2026-12-31')).toEqual({ start: '2026-12-01', end: '2026-12-31' })
    expect(getNextMonthBounds('2026-12-31')).toEqual({ start: '2027-01-01', end: '2027-01-31' })
    const summary = calculateFixedExpenseSummary([
      period({ id: 'december', due_date: '2026-12-31' }),
      period({ id: 'january', due_date: '2027-01-31' }),
    ], '2026-12-31')
    expect(summary.pendingThisMonth.map((item) => item.id)).toEqual(['december'])
    expect(summary.nextMonthPending.map((item) => item.id)).toEqual(['january'])
    expect(summary.overdue).toHaveLength(0)
  })
})
