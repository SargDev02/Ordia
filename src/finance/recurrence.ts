import type { FixedExpenseFrequency, FixedExpensePeriod } from '../types/finance'

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return { day, month, year }
}

function formatDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function lastDayOfMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function getRecurringDueDate(anchorDate: string, frequency: FixedExpenseFrequency, occurrence: number) {
  if (!Number.isInteger(occurrence) || occurrence < 0) throw new Error('La ocurrencia debe ser un entero no negativo.')
  const anchor = parseDate(anchorDate)
  const monthOffset = frequency === 'monthly' ? occurrence : occurrence * 12
  const absoluteMonth = anchor.year * 12 + anchor.month - 1 + monthOffset
  const year = Math.floor(absoluteMonth / 12)
  const month = absoluteMonth % 12 + 1
  return formatDate(year, month, Math.min(anchor.day, lastDayOfMonth(year, month)))
}

export function buildRecurringDueDates(anchorDate: string, frequency: FixedExpenseFrequency, throughDate: string) {
  const dates: string[] = []
  for (let occurrence = 0; occurrence <= 1200; occurrence += 1) {
    const dueDate = getRecurringDueDate(anchorDate, frequency, occurrence)
    if (dueDate > throughDate) break
    dates.push(dueDate)
  }
  return dates
}

export function getFixedExpensePeriodState(period: FixedExpensePeriod, today: string) {
  if (period.cancelled_at) return 'cancelled' as const
  if (period.transaction_id) return 'paid' as const
  if (period.due_date < today) return 'overdue' as const
  return 'pending' as const
}

export interface FixedExpensePeriodOverview {
  fixedExpenseId: string
  mainPending: FixedExpensePeriod | null
  mainPendingCount: number
  nextMonthPending: FixedExpensePeriod | null
  oldestOverdue: FixedExpensePeriod | null
  overdueCount: number
  paidCount: number
}

export function buildFixedExpensePeriodOverviews(periods: FixedExpensePeriod[], today: string) {
  const currentMonth = getMonthBounds(today)
  const nextMonth = getNextMonthBounds(today)
  const grouped = new Map<string, FixedExpensePeriod[]>()
  for (const period of periods) {
    if (period.cancelled_at) continue
    const group = grouped.get(period.fixed_expense_id) ?? []
    group.push(period)
    grouped.set(period.fixed_expense_id, group)
  }

  return [...grouped.entries()].map<FixedExpensePeriodOverview>(([fixedExpenseId, group]) => {
    const pending = group.filter((period) => !period.transaction_id).sort((a, b) => a.due_date.localeCompare(b.due_date))
    const overdue = pending.filter((period) => period.due_date < today)
    const mainPending = pending.filter((period) => period.due_date < today || isWithin(period.due_date, currentMonth))
    const nextMonthPending = pending.filter((period) => isWithin(period.due_date, nextMonth))
    return {
      fixedExpenseId,
      mainPending: mainPending[0] ?? null,
      mainPendingCount: mainPending.length,
      nextMonthPending: nextMonthPending[0] ?? null,
      oldestOverdue: overdue[0] ?? null,
      overdueCount: overdue.length,
      paidCount: group.filter((period) => period.transaction_id).length,
    }
  })
}

export function calculateFixedExpenseSummary(periods: FixedExpensePeriod[], today: string) {
  const currentMonth = getMonthBounds(today)
  const nextMonth = getNextMonthBounds(today)
  const visible = periods.filter((period) => !period.cancelled_at)
  const unpaid = visible.filter((period) => !period.transaction_id)
  const pendingThisMonth = unpaid.filter((period) => isWithin(period.due_date, currentMonth))
  const overdue = unpaid.filter((period) => period.due_date < today)
  const paidThisMonth = visible.filter((period) => period.transaction_id && period.paid_on && isWithin(period.paid_on, currentMonth))
  const nextMonthPending = unpaid.filter((period) => isWithin(period.due_date, nextMonth))
  const prepaidDueThisMonth = visible.filter((period) => period.transaction_id && period.paid_on && isWithin(period.due_date, currentMonth) && period.paid_on < currentMonth.start)

  return {
    currentMonth,
    nextMonth,
    nextMonthPending,
    nextMonthPendingAmount: sumPeriodAmounts(nextMonthPending, false),
    overdue,
    overdueAmount: sumPeriodAmounts(overdue, false),
    paidThisMonth,
    paidThisMonthAmount: sumPeriodAmounts(paidThisMonth, true),
    pendingThisMonth,
    pendingThisMonthAmount: sumPeriodAmounts(pendingThisMonth, false),
    prepaidDueThisMonth,
  }
}

export function getMonthBounds(date: string) {
  const { year, month } = parseDate(date)
  return {
    start: formatDate(year, month, 1),
    end: formatDate(year, month, lastDayOfMonth(year, month)),
  }
}

export function getNextMonthBounds(date: string) {
  const { year, month } = parseDate(date)
  const absoluteMonth = year * 12 + month
  const nextYear = Math.floor(absoluteMonth / 12)
  const nextMonth = absoluteMonth % 12 + 1
  return {
    start: formatDate(nextYear, nextMonth, 1),
    end: formatDate(nextYear, nextMonth, lastDayOfMonth(nextYear, nextMonth)),
  }
}

function isWithin(date: string, range: { start: string; end: string }) {
  return date >= range.start && date <= range.end
}

function sumPeriodAmounts(periods: FixedExpensePeriod[], paid: boolean) {
  return periods.reduce((sum, period) => sum + BigInt(paid ? period.paid_amount ?? 0 : period.expected_amount), 0n)
}
