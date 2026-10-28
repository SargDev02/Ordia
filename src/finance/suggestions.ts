import type { FinancialAccount, FinancialCategory, FinancialTransaction, FixedExpense, FixedExpensePeriod } from '../types/finance'
import { calculateAccountBalance, formatCop, getBogotaMonthBounds, getBogotaToday } from './calculations'

export interface SuggestionScope {
  accountNames: string[]
  accountCount: number
  isAllAccounts: boolean
  periodStart: string
  periodEnd: string
}

export interface OverdueNoticeItem {
  periodId: string
  fixedExpenseId: string
  name: string
  dueDate: string
  expectedAmount: number
  suggestedAccountId: string | null
  suggestedAccountName: string | null
}

export interface OverdueNotice {
  kind: 'overdue'
  title: string
  totalAmount: bigint
  count: number
  oldestDueDate: string
  items: OverdueNoticeItem[]
  description: string
}

export interface InsufficientBalanceNotice {
  kind: 'insufficient_balance'
  accountId: string
  accountName: string
  currentBalance: bigint
  requiredAmount: bigint
  deficitAmount: bigint
  commitmentsCount: number
  windowStart: string
  windowEnd: string
  items: Array<{
    periodId: string
    name: string
    dueDate: string
    expectedAmount: number
    isOverdue: boolean
  }>
  description: string
}

export interface CoveredAccountSummary {
  accountId: string
  accountName: string
  currentBalance: bigint
  commitmentsAmount: bigint
  remainingEstimatedBalance: bigint
}

export interface UnassignedObligationItem {
  periodId: string
  name: string
  dueDate: string
  expectedAmount: number
}

export interface UpcomingPaymentsNotice {
  kind: 'upcoming_payments'
  windowStart: string
  windowEnd: string
  totalAmount: bigint
  count: number
  coveredAccounts: CoveredAccountSummary[]
  unassignedItems: UnassignedObligationItem[]
  unassignedTotalAmount: bigint
  description: string
}

export interface CategoryShare {
  categoryId: string
  categoryName: string
  amount: bigint
  percentage: number
}

export interface ExpenseComparisonNotice {
  kind: 'expense_comparison'
  currentPeriod: {
    start: string
    end: string
    expense: bigint
    daysElapsed: number
  }
  previousPeriod: {
    start: string
    end: string
    expense: bigint
    daysElapsed: number
    monthName: string
    year: number
  }
  adjustmentExplanation: string
  hasPreviousData: boolean
  differenceAmount: bigint
  percentageChange: number | null
  topCategories: CategoryShare[]
  description: string
}

export interface CashFlowSummaryNotice {
  kind: 'cash_flow_summary'
  periodStart: string
  periodEnd: string
  income: bigint
  expense: bigint
  net: bigint
  description: string
}

export interface FinancialSuggestionsResult {
  hasAccountsSelected: boolean
  scope: SuggestionScope
  overdueNotice: OverdueNotice | null
  insufficientBalanceNotices: InsufficientBalanceNotice[]
  upcomingPaymentsNotice: UpcomingPaymentsNotice | null
  expenseComparisonNotice: ExpenseComparisonNotice | null
  cashFlowSummaryNotice: CashFlowSummaryNotice | null
  topCategories: CategoryShare[]
  emptyReason: 'no_accounts' | 'no_data' | null
}

export interface SuggestionsInput {
  accounts: FinancialAccount[]
  transactions: FinancialTransaction[]
  categories: FinancialCategory[]
  fixedExpenses: FixedExpense[]
  fixedExpensePeriods: FixedExpensePeriod[]
  selectedAccountIds: ReadonlySet<string>
  dateFrom?: string
  dateTo?: string
  now?: Date
  today?: string
}

export function getSpanishMonthName(monthNumber: number): string {
  const months = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ]
  return months[monthNumber - 1] ?? ''
}

export function addDaysToDate(dateString: string, days: number): string {
  const [year, month, day] = dateString.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function getLastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Motor determinista de sugerencias financieras.
 * Analiza movimientos, categorías, cuentas y obligaciones fijas
 * con base exclusivamente en los datos registrados en Ordia.
 */
export function generateFinancialSuggestions({
  accounts,
  transactions,
  categories,
  fixedExpenses,
  fixedExpensePeriods,
  selectedAccountIds,
  dateFrom,
  dateTo,
  now = new Date(),
  today: inputToday,
}: SuggestionsInput): FinancialSuggestionsResult {
  const today = inputToday || getBogotaToday(now)
  const monthBounds = getBogotaMonthBounds(now)
  const periodStart = dateFrom || monthBounds.start
  const periodEnd = dateTo || monthBounds.end

  const activeOrSelectedAccounts = accounts.filter((account) => selectedAccountIds.has(account.id))
  const isAllAccounts = accounts.length > 0 && selectedAccountIds.size === accounts.length
  const accountNames = activeOrSelectedAccounts.map((account) => account.name)

  const scope: SuggestionScope = {
    accountNames,
    accountCount: selectedAccountIds.size,
    isAllAccounts,
    periodStart,
    periodEnd,
  }

  // Si no hay cuentas seleccionadas, no fabricar sugerencias y devolver estado vacío
  if (selectedAccountIds.size === 0) {
    return {
      hasAccountsSelected: false,
      scope,
      overdueNotice: null,
      insufficientBalanceNotices: [],
      upcomingPaymentsNotice: null,
      expenseComparisonNotice: null,
      cashFlowSummaryNotice: null,
      topCategories: [],
      emptyReason: 'no_accounts',
    }
  }

  const fixedExpenseMap = new Map(fixedExpenses.map((fe) => [fe.id, fe.name]))
  const accountNameMap = new Map(accounts.map((acc) => [acc.id, acc.name]))
  const categoryMap = new Map(categories.map((c) => [c.id, c]))

  // -------------------------------------------------------------
  // 1. OBLIGACIONES VENCIDAS (prioridad alta)
  // -------------------------------------------------------------
  // Unpaid, non-cancelled, due_date < today
  // Incluye obligaciones asociadas a las cuentas seleccionadas y obligaciones sin cuenta sugerida
  const overduePeriods = fixedExpensePeriods
    .filter((period) => {
      if (period.cancelled_at || period.transaction_id) return false
      if (period.due_date >= today) return false
      if (period.suggested_account_id) {
        return selectedAccountIds.has(period.suggested_account_id)
      }
      return true
    })
    .sort((a, b) => a.due_date.localeCompare(b.due_date))

  let overdueNotice: OverdueNotice | null = null
  if (overduePeriods.length > 0) {
    const totalAmount = overduePeriods.reduce((acc, p) => acc + BigInt(p.expected_amount), 0n)
    const oldestDueDate = overduePeriods[0].due_date
    const items: OverdueNoticeItem[] = overduePeriods.map((period) => ({
      periodId: period.id,
      fixedExpenseId: period.fixed_expense_id,
      name: fixedExpenseMap.get(period.fixed_expense_id) ?? 'Gasto fijo',
      dueDate: period.due_date,
      expectedAmount: period.expected_amount,
      suggestedAccountId: period.suggested_account_id,
      suggestedAccountName: period.suggested_account_id ? accountNameMap.get(period.suggested_account_id) ?? null : null,
    }))

    overdueNotice = {
      kind: 'overdue',
      title: `${overduePeriods.length} obligación${overduePeriods.length === 1 ? '' : 'es'} fija${overduePeriods.length === 1 ? '' : 's'} vencida${overduePeriods.length === 1 ? '' : 's'}`,
      totalAmount,
      count: overduePeriods.length,
      oldestDueDate,
      items,
      description: `Tienes ${overduePeriods.length} obligación${overduePeriods.length === 1 ? '' : 'es'} pendiente${overduePeriods.length === 1 ? '' : 's'} por un total de ${formatCop(totalAmount)} con vencimiento anterior a hoy (la más antigua venció el ${oldestDueDate}).`,
    }
  }

  // -------------------------------------------------------------
  // 2. PAGOS PRÓXIMOS Y SALDO INSUFICIENTE (próximos 7 días)
  // -------------------------------------------------------------
  const windowStart = today
  const windowEnd = addDaysToDate(today, 6) // 7 días continuos incluyendo hoy

  // Períodos que vencen en los próximos 7 días (impagos, no cancelados)
  const upcomingPeriods = fixedExpensePeriods
    .filter((period) => {
      if (period.cancelled_at || period.transaction_id) return false
      if (period.due_date < windowStart || period.due_date > windowEnd) return false
      if (period.suggested_account_id) {
        return selectedAccountIds.has(period.suggested_account_id)
      }
      return true
    })
    .sort((a, b) => a.due_date.localeCompare(b.due_date))

  const insufficientBalanceNotices: InsufficientBalanceNotice[] = []
  const coveredAccounts: CoveredAccountSummary[] = []

  // Agrupar compromisos por cuenta sugerida para las cuentas seleccionadas
  // Un compromiso por cuenta incluye sus pagos próximos (7 días) más sus vencidos impagos
  for (const account of activeOrSelectedAccounts) {
    const currentBalance = calculateAccountBalance(account, transactions)

    // Pagos en los próximos 7 días con sugerencia en esta cuenta
    const accountUpcoming = upcomingPeriods.filter((p) => p.suggested_account_id === account.id)
    // Pagos vencidos impagos en esta cuenta
    const accountOverdue = overduePeriods.filter((p) => p.suggested_account_id === account.id)

    const allAccountCommitments = [
      ...accountOverdue.map((p) => ({
        periodId: p.id,
        name: fixedExpenseMap.get(p.fixed_expense_id) ?? 'Gasto fijo',
        dueDate: p.due_date,
        expectedAmount: p.expected_amount,
        isOverdue: true,
      })),
      ...accountUpcoming.map((p) => ({
        periodId: p.id,
        name: fixedExpenseMap.get(p.fixed_expense_id) ?? 'Gasto fijo',
        dueDate: p.due_date,
        expectedAmount: p.expected_amount,
        isOverdue: false,
      })),
    ]

    if (allAccountCommitments.length > 0) {
      const requiredAmount = allAccountCommitments.reduce((sum, item) => sum + BigInt(item.expectedAmount), 0n)

      if (currentBalance < requiredAmount) {
        const deficitAmount = requiredAmount - currentBalance
        insufficientBalanceNotices.push({
          kind: 'insufficient_balance',
          accountId: account.id,
          accountName: account.name,
          currentBalance,
          requiredAmount,
          deficitAmount,
          commitmentsCount: allAccountCommitments.length,
          windowStart,
          windowEnd,
          items: allAccountCommitments,
          description: `El saldo actual registrado en «${account.name}» (${formatCop(currentBalance)}) no cubre los compromisos vencidos y los próximos 7 días (${formatCop(requiredAmount)}). Faltan ${formatCop(deficitAmount)} para completar los pagos.`,
        })
      } else {
        coveredAccounts.push({
          accountId: account.id,
          accountName: account.name,
          currentBalance,
          commitmentsAmount: requiredAmount,
          remainingEstimatedBalance: currentBalance - requiredAmount,
        })
      }
    }
  }

  // Obligaciones sin cuenta sugerida asignada en los próximos 7 días
  const unassignedUpcoming = upcomingPeriods.filter((p) => !p.suggested_account_id)
  const unassignedItems: UnassignedObligationItem[] = unassignedUpcoming.map((p) => ({
    periodId: p.id,
    name: fixedExpenseMap.get(p.fixed_expense_id) ?? 'Gasto fijo',
    dueDate: p.due_date,
    expectedAmount: p.expected_amount,
  }))
  const unassignedTotalAmount = unassignedItems.reduce((acc, item) => acc + BigInt(item.expectedAmount), 0n)

  let upcomingPaymentsNotice: UpcomingPaymentsNotice | null = null
  if (upcomingPeriods.length > 0) {
    const totalAmount = upcomingPeriods.reduce((acc, p) => acc + BigInt(p.expected_amount), 0n)
    let description = `Tienes ${upcomingPeriods.length} pago${upcomingPeriods.length === 1 ? '' : 's'} programado${upcomingPeriods.length === 1 ? '' : 's'} por ${formatCop(totalAmount)} entre ${windowStart} y ${windowEnd}.`
    if (!isAllAccounts && unassignedItems.length > 0) {
      description += ` ${unassignedItems.length} de ellos no tiene${unassignedItems.length === 1 ? '' : 'n'} cuenta sugerida asignada.`
    }
    upcomingPaymentsNotice = {
      kind: 'upcoming_payments',
      windowStart,
      windowEnd,
      totalAmount,
      count: upcomingPeriods.length,
      coveredAccounts,
      unassignedItems,
      unassignedTotalAmount,
      description,
    }
  }

  // -------------------------------------------------------------
  // 3. RESUMEN DE FLUJO NETO (Período seleccionado)
  // -------------------------------------------------------------
  // Filtrar movimientos del período para las cuentas seleccionadas (sin transferencias ni eliminados)
  const periodTransactions = transactions.filter((t) => {
    if (t.deleted_at || t.kind === 'transfer') return false
    if (!selectedAccountIds.has(t.account_id)) return false
    if (t.occurred_on < periodStart || t.occurred_on > periodEnd) return false
    return true
  })

  let periodIncome = 0n
  let periodExpense = 0n
  for (const t of periodTransactions) {
    const amount = BigInt(t.amount)
    if (t.kind === 'income') periodIncome += amount
    if (t.kind === 'expense') periodExpense += amount
  }

  const netFlow = periodIncome - periodExpense
  let flowDescription = ''
  if (periodIncome === 0n && periodExpense === 0n) {
    flowDescription = 'No hay ingresos ni gastos registrados en el período y cuentas seleccionadas.'
  } else if (netFlow > 0n) {
    flowDescription = `Superávit de ${formatCop(netFlow)}: los ingresos registrados superan a los gastos en el período.`
  } else if (netFlow < 0n) {
    flowDescription = `Déficit de ${formatCop(-netFlow)}: los gastos registrados superan a los ingresos en el período.`
  } else {
    flowDescription = `Ingresos y gastos registrados equilibrados exactamente en ${formatCop(periodIncome)}.`
  }

  const cashFlowSummaryNotice: CashFlowSummaryNotice = {
    kind: 'cash_flow_summary',
    periodStart,
    periodEnd,
    income: periodIncome,
    expense: periodExpense,
    net: netFlow,
    description: flowDescription,
  }

  // -------------------------------------------------------------
  // 4. COMPARACIÓN DE GASTOS CON EL MES ANTERIOR (Mismos días transcurridos)
  // -------------------------------------------------------------
  // Analizar los días transcurridos del mes en curso en Bogotá
  const [currentYear, currentMonthNum, currentDayNum] = today.split('-').map(Number)
  const currentMonthStart = `${currentYear}-${String(currentMonthNum).padStart(2, '0')}-01`
  // La comparación se realiza sobre los días transcurridos de hoy: 1 al día actual
  const currentDaysElapsed = currentDayNum
  const currentElapsedEnd = today

  // Mes anterior en el calendario
  const prevYear = currentMonthNum === 1 ? currentYear - 1 : currentYear
  const prevMonthNum = currentMonthNum === 1 ? 12 : currentMonthNum - 1
  const prevMonthLastDay = getLastDayOfMonth(prevYear, prevMonthNum)
  const prevDaysElapsed = Math.min(currentDaysElapsed, prevMonthLastDay)

  const prevMonthStart = `${prevYear}-${String(prevMonthNum).padStart(2, '0')}-01`
  const prevMonthEnd = `${prevYear}-${String(prevMonthNum).padStart(2, '0')}-${String(prevDaysElapsed).padStart(2, '0')}`
  const prevMonthName = getSpanishMonthName(prevMonthNum)
  const currentMonthName = getSpanishMonthName(currentMonthNum)

  let adjustmentExplanation = ''
  if (currentDaysElapsed > prevMonthLastDay) {
    adjustmentExplanation = `El mes anterior (${prevMonthName} ${prevYear}) tuvo ${prevMonthLastDay} días. La comparación se ajusta del día 1 al ${prevMonthLastDay} frente a los ${currentDaysElapsed} días transcurridos de ${currentMonthName}.`
  } else {
    adjustmentExplanation = `Comparación entre los primeros ${currentDaysElapsed} días de ${currentMonthName} y los mismos ${currentDaysElapsed} días de ${prevMonthName} ${prevYear}.`
  }

  // Gastos actuales en el rango transcurrido (1 a hoy)
  const currentElapsedTransactions = transactions.filter((t) => {
    if (t.deleted_at || t.kind !== 'expense') return false
    if (!selectedAccountIds.has(t.account_id)) return false
    return t.occurred_on >= currentMonthStart && t.occurred_on <= currentElapsedEnd
  })
  const currentElapsedExpense = currentElapsedTransactions.reduce((acc, t) => acc + BigInt(t.amount), 0n)

  // Gastos del mes anterior en el rango equivalente (1 a prevDaysElapsed)
  const prevElapsedTransactions = transactions.filter((t) => {
    if (t.deleted_at || t.kind !== 'expense') return false
    if (!selectedAccountIds.has(t.account_id)) return false
    return t.occurred_on >= prevMonthStart && t.occurred_on <= prevMonthEnd
  })
  const prevElapsedExpense = prevElapsedTransactions.reduce((acc, t) => acc + BigInt(t.amount), 0n)

  // Categorías con mayor gasto en el período seleccionado (agrupando subcategorías bajo su categoría raíz)
  const expensesByCategory = new Map<string, bigint>()
  for (const t of periodTransactions) {
    if (t.kind !== 'expense') continue
    const amount = BigInt(t.amount)
    const category = t.category_id ? categoryMap.get(t.category_id) : null
    const rootId = category?.parent_id ?? category?.id ?? 'unavailable'
    expensesByCategory.set(rootId, (expensesByCategory.get(rootId) ?? 0n) + amount)
  }

  const topCategories: CategoryShare[] = [...expensesByCategory.entries()]
    .map(([catId, amount]) => {
      const name = categoryMap.get(catId)?.name ?? 'Sin categoría'
      const percentage = periodExpense > 0n
        ? Math.round(Number(amount * 10000n / periodExpense)) / 100
        : 0
      return { categoryId: catId, categoryName: name, amount, percentage }
    })
    .sort((a, b) => Number(b.amount - a.amount))
    .slice(0, 3)

  const hasPreviousData = prevElapsedExpense > 0n
  const expenseDifference = currentElapsedExpense - prevElapsedExpense
  let percentageChange: number | null = null
  let comparisonDescription = ''

  if (prevElapsedExpense === 0n) {
    if (currentElapsedExpense === 0n) {
      comparisonDescription = 'No se registran gastos en los días transcurridos de este mes ni en el mismo período del mes anterior.'
    } else {
      comparisonDescription = `Gastos registrados a la fecha: ${formatCop(currentElapsedExpense)}. No hay gastos registrados en el mismo período del mes anterior para calcular variación porcentual.`
    }
  } else {
    // Cálculo seguro de porcentaje sin división por cero
    percentageChange = Math.round(Number((expenseDifference * 10000n) / prevElapsedExpense)) / 100
    if (expenseDifference > 0n) {
      comparisonDescription = `Los gastos registrados aumentaron ${formatCop(expenseDifference)} (+${percentageChange.toFixed(1)}%) frente al mismo período de ${prevMonthName}.`
    } else if (expenseDifference < 0n) {
      comparisonDescription = `Los gastos registrados disminuyeron ${formatCop(-expenseDifference)} (${percentageChange.toFixed(1)}%) frente al mismo período de ${prevMonthName}.`
    } else {
      comparisonDescription = `Los gastos registrados se mantuvieron exactamente iguales a los del mismo período de ${prevMonthName} (${formatCop(currentElapsedExpense)}).`
    }
  }

  const expenseComparisonNotice: ExpenseComparisonNotice = {
    kind: 'expense_comparison',
    currentPeriod: {
      start: currentMonthStart,
      end: currentElapsedEnd,
      expense: currentElapsedExpense,
      daysElapsed: currentDaysElapsed,
    },
    previousPeriod: {
      start: prevMonthStart,
      end: prevMonthEnd,
      expense: prevElapsedExpense,
      daysElapsed: prevDaysElapsed,
      monthName: prevMonthName,
      year: prevYear,
    },
    adjustmentExplanation,
    hasPreviousData,
    differenceAmount: expenseDifference,
    percentageChange,
    topCategories,
    description: comparisonDescription,
  }

  const hasAnyData = periodTransactions.length > 0 || overduePeriods.length > 0 || upcomingPeriods.length > 0
  const emptyReason = !hasAnyData ? 'no_data' : null

  return {
    hasAccountsSelected: true,
    scope,
    overdueNotice,
    insufficientBalanceNotices,
    upcomingPaymentsNotice,
    expenseComparisonNotice,
    cashFlowSummaryNotice,
    topCategories,
    emptyReason,
  }
}
