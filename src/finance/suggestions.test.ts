import { describe, expect, it } from 'vitest'
import {
  addDaysToDate,
  generateFinancialSuggestions,
  getLastDayOfMonth,
  getSpanishMonthName,
} from './suggestions'
import type {
  FinancialAccount,
  FinancialCategory,
  FinancialTransaction,
  FixedExpense,
  FixedExpensePeriod,
  TransactionKind,
} from '../types/finance'

function account(id: string, name: string, initialBalance = 0): FinancialAccount {
  return {
    id,
    user_id: 'user-1',
    name,
    account_type: 'bank',
    currency: 'COP',
    initial_balance: initialBalance,
    archived_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function transaction(
  id: string,
  kind: TransactionKind,
  amount: number,
  occurredOn: string,
  accountId = 'acc-1',
  overrides: Partial<FinancialTransaction> = {},
): FinancialTransaction {
  return {
    id,
    user_id: 'user-1',
    kind,
    account_id: accountId,
    destination_account_id: kind === 'transfer' ? 'acc-2' : null,
    amount,
    occurred_on: occurredOn,
    category_id: kind === 'transfer' ? null : 'cat-1',
    description: null,
    client_request_id: `req-${id}`,
    deleted_at: null,
    created_at: `${occurredOn}T10:00:00Z`,
    updated_at: `${occurredOn}T10:00:00Z`,
    ...overrides,
  }
}

function category(id: string, name: string, kind: 'income' | 'expense', parentId: string | null = null): FinancialCategory {
  return {
    id,
    user_id: 'user-1',
    name,
    kind,
    parent_id: parentId,
    archived_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function fixedExpense(id: string, name: string): FixedExpense {
  return {
    id,
    user_id: 'user-1',
    name,
    client_request_id: `fe-${id}`,
    status: 'active',
    notes: null,
    paused_at: null,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }
}

function period(
  id: string,
  fixedExpenseId: string,
  dueDate: string,
  expectedAmount: number,
  suggestedAccountId: string | null = 'acc-1',
  overrides: Partial<FixedExpensePeriod> = {},
): FixedExpensePeriod {
  return {
    id,
    user_id: 'user-1',
    fixed_expense_id: fixedExpenseId,
    version_id: `ver-${fixedExpenseId}`,
    due_date: dueDate,
    expected_amount: expectedAmount,
    currency: 'COP',
    category_id: 'cat-1',
    suggested_account_id: suggestedAccountId,
    transaction_id: null,
    payment_request_id: null,
    paid_amount: null,
    paid_on: null,
    paid_account_id: null,
    paid_category_id: null,
    paid_at: null,
    cancelled_at: null,
    cancellation_reason: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('utilidades de fechas del motor determinista', () => {
  it('agrega días respetando fin de mes y año', () => {
    expect(addDaysToDate('2026-10-28', 6)).toBe('2026-11-03')
    expect(addDaysToDate('2026-12-30', 5)).toBe('2027-01-04')
    expect(addDaysToDate('2026-02-27', 3)).toBe('2026-03-02')
  })

  it('obtiene el último día del mes considerando bisiestos', () => {
    expect(getLastDayOfMonth(2026, 2)).toBe(28)
    expect(getLastDayOfMonth(2024, 2)).toBe(29)
    expect(getLastDayOfMonth(2026, 10)).toBe(31)
    expect(getLastDayOfMonth(2026, 9)).toBe(30)
  })

  it('devuelve el nombre del mes en español', () => {
    expect(getSpanishMonthName(1)).toBe('enero')
    expect(getSpanishMonthName(10)).toBe('octubre')
    expect(getSpanishMonthName(12)).toBe('diciembre')
  })
})

describe('motor determinista de sugerencias financieras', () => {
  const accounts = [
    account('acc-1', 'Bancolombia', 1_000_000),
    account('acc-2', 'Davivienda', 200_000),
  ]

  const categories = [
    category('cat-salary', 'Salario', 'income'),
    category('cat-food', 'Alimentación', 'expense'),
    category('cat-restaurants', 'Restaurantes', 'expense', 'cat-food'),
    category('cat-services', 'Servicios', 'expense'),
  ]

  const fixedExpensesList = [
    fixedExpense('fe-rent', 'Arriendo'),
    fixedExpense('fe-internet', 'Internet Fibra'),
    fixedExpense('fe-gym', 'Gimnasio'),
  ]

  // Fecha fija para pruebas: 28 de octubre de 2026 a las 14:00 Bogotá
  const mockNow = new Date('2026-10-28T19:00:00Z')

  it('maneja el estado vacío cuando no hay cuentas seleccionadas', () => {
    const result = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods: [],
      selectedAccountIds: new Set<string>(),
      now: mockNow,
    })

    expect(result.hasAccountsSelected).toBe(false)
    expect(result.emptyReason).toBe('no_accounts')
    expect(result.overdueNotice).toBeNull()
    expect(result.upcomingPaymentsNotice).toBeNull()
    expect(result.expenseComparisonNotice).toBeNull()
  })

  it('excluye transferencias, saldos iniciales y movimientos eliminados de los totales', () => {
    const transactions = [
      transaction('tx-1', 'income', 500_000, '2026-10-10', 'acc-1'),
      transaction('tx-2', 'expense', 150_000, '2026-10-12', 'acc-1'),
      transaction('tx-3', 'transfer', 200_000, '2026-10-15', 'acc-1'), // Transferencia excluida
      transaction('tx-4', 'expense', 80_000, '2026-10-18', 'acc-1', {
        deleted_at: '2026-10-19T00:00:00Z', // Eliminado lógicamente
      }),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions,
      categories,
      fixedExpenses: [],
      fixedExpensePeriods: [],
      selectedAccountIds: new Set(['acc-1']),
      now: mockNow,
    })

    expect(result.hasAccountsSelected).toBe(true)
    expect(result.cashFlowSummaryNotice).not.toBeNull()
    expect(result.cashFlowSummaryNotice?.income).toBe(500_000n)
    expect(result.cashFlowSummaryNotice?.expense).toBe(150_000n)
    expect(result.cashFlowSummaryNotice?.net).toBe(350_000n)
    expect(result.cashFlowSummaryNotice?.description).toContain('Superávit de')
    expect(result.cashFlowSummaryNotice?.description).toContain('350.000')
  })

  it('agrupa subcategorías bajo su categoría raíz sin duplicar importes', () => {
    const transactions = [
      transaction('tx-1', 'expense', 200_000, '2026-10-05', 'acc-1', { category_id: 'cat-food' }),
      transaction('tx-2', 'expense', 100_000, '2026-10-15', 'acc-1', { category_id: 'cat-restaurants' }), // Subcategoría de cat-food
      transaction('tx-3', 'expense', 100_000, '2026-10-20', 'acc-1', { category_id: 'cat-services' }),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions,
      categories,
      fixedExpenses: [],
      fixedExpensePeriods: [],
      selectedAccountIds: new Set(['acc-1']),
      now: mockNow,
    })

    const comparison = result.expenseComparisonNotice
    expect(comparison).not.toBeNull()
    // Total gastos: 400.000. cat-food debe tener 300.000 (75%)
    expect(comparison?.topCategories[0].categoryName).toBe('Alimentación')
    expect(comparison?.topCategories[0].amount).toBe(300_000n)
    expect(comparison?.topCategories[0].percentage).toBe(75)

    expect(comparison?.topCategories[1].categoryName).toBe('Servicios')
    expect(comparison?.topCategories[1].amount).toBe(100_000n)
    expect(comparison?.topCategories[1].percentage).toBe(25)
  })

  it('compara el mes actual con los mismos días transcurridos del mes anterior', () => {
    // Hoy es 28 de octubre. Rango mes actual: 01-28 oct. Rango mes anterior: 01-28 sep.
    const transactions = [
      // Octubre (actual)
      transaction('tx-oct-1', 'expense', 300_000, '2026-10-10', 'acc-1'),
      // Septiembre dentro del rango (1 a 28)
      transaction('tx-sep-1', 'expense', 200_000, '2026-09-15', 'acc-1'),
      // Septiembre fuera del rango (día 29)
      transaction('tx-sep-late', 'expense', 500_000, '2026-09-29', 'acc-1'),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions,
      categories,
      fixedExpenses: [],
      fixedExpensePeriods: [],
      selectedAccountIds: new Set(['acc-1']),
      now: mockNow,
    })

    const notice = result.expenseComparisonNotice
    expect(notice).not.toBeNull()
    expect(notice?.currentPeriod.expense).toBe(300_000n)
    expect(notice?.previousPeriod.expense).toBe(200_000n) // No incluye el del 29
    expect(notice?.differenceAmount).toBe(100_000n)
    expect(notice?.percentageChange).toBe(50) // +50%
    expect(notice?.description).toContain('aumentaron')
    expect(notice?.description).toContain('100.000')
    expect(notice?.description).toContain('+50.0%')
    expect(notice?.adjustmentExplanation).toContain('primeros 28 días de octubre y los mismos 28 días de septiembre 2026')
  })

  it('ajusta la explicación cuando los meses tienen distinta duración (ej. marzo 31 vs febrero 28)', () => {
    const marchDate = new Date('2026-03-31T15:00:00Z') // 31 de marzo en Bogotá
    const transactions = [
      transaction('tx-mar', 'expense', 400_000, '2026-03-15', 'acc-1'),
      transaction('tx-feb', 'expense', 350_000, '2026-02-20', 'acc-1'),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions,
      categories,
      fixedExpenses: [],
      fixedExpensePeriods: [],
      selectedAccountIds: new Set(['acc-1']),
      now: marchDate,
    })

    const notice = result.expenseComparisonNotice
    expect(notice?.currentPeriod.daysElapsed).toBe(31)
    expect(notice?.previousPeriod.daysElapsed).toBe(28)
    expect(notice?.previousPeriod.end).toBe('2026-02-28')
    expect(notice?.adjustmentExplanation).toContain('tuvo 28 días. La comparación se ajusta del día 1 al 28 frente a los 31 días transcurridos de marzo')
  })

  it('maneja el cambio de año (ej. 15 de enero compara con 15 de diciembre del año anterior)', () => {
    const janDate = new Date('2027-01-15T15:00:00Z')
    const transactions = [
      transaction('tx-jan', 'expense', 150_000, '2027-01-10', 'acc-1'),
      transaction('tx-dec', 'expense', 200_000, '2026-12-10', 'acc-1'),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions,
      categories,
      fixedExpenses: [],
      fixedExpensePeriods: [],
      selectedAccountIds: new Set(['acc-1']),
      now: janDate,
    })

    const notice = result.expenseComparisonNotice
    expect(notice?.currentPeriod.start).toBe('2027-01-01')
    expect(notice?.currentPeriod.end).toBe('2027-01-15')
    expect(notice?.previousPeriod.start).toBe('2026-12-01')
    expect(notice?.previousPeriod.end).toBe('2026-12-15')
    expect(notice?.previousPeriod.year).toBe(2026)
    expect(notice?.previousPeriod.monthName).toBe('diciembre')
    expect(notice?.differenceAmount).toBe(-50_000n)
    expect(notice?.percentageChange).toBe(-25)
    expect(notice?.description).toContain('disminuyeron')
    expect(notice?.description).toContain('50.000')
    expect(notice?.description).toContain('-25.0%')
    expect(notice?.description).toContain('diciembre')
  })

  it('evita porcentajes engañosos cuando no hay gastos anteriores o son cero', () => {
    const transactions = [
      transaction('tx-current', 'expense', 250_000, '2026-10-15', 'acc-1'),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions,
      categories,
      fixedExpenses: [],
      fixedExpensePeriods: [],
      selectedAccountIds: new Set(['acc-1']),
      now: mockNow,
    })

    const notice = result.expenseComparisonNotice
    expect(notice?.hasPreviousData).toBe(false)
    expect(notice?.percentageChange).toBeNull()
    expect(notice?.description).toContain('No hay gastos registrados en el mismo período del mes anterior para calcular variación porcentual')
  })

  it('detecta obligaciones vencidas y las presenta de forma independiente', () => {
    const fixedExpensePeriods = [
      // Vencida: due_date 2026-10-20 (< hoy 2026-10-28)
      period('per-overdue-1', 'fe-rent', '2026-10-20', 800_000, 'acc-1'),
      // Vencida pero ya pagada (debe ignorarse)
      period('per-overdue-paid', 'fe-internet', '2026-10-15', 100_000, 'acc-1', {
        transaction_id: 'tx-paid',
      }),
      // Vencida pero cancelada (debe ignorarse)
      period('per-overdue-cancelled', 'fe-gym', '2026-10-10', 90_000, 'acc-1', {
        cancelled_at: '2026-10-11T00:00:00Z',
      }),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods,
      selectedAccountIds: new Set(['acc-1']),
      now: mockNow,
    })

    expect(result.overdueNotice).not.toBeNull()
    expect(result.overdueNotice?.count).toBe(1)
    expect(result.overdueNotice?.totalAmount).toBe(800_000n)
    expect(result.overdueNotice?.oldestDueDate).toBe('2026-10-20')
    expect(result.overdueNotice?.items[0].name).toBe('Arriendo')
  })

  it('calcula los pagos próximos en la ventana de 7 días (28 oct a 3 nov)', () => {
    const fixedExpensePeriods = [
      // Próximo hoy (28 oct)
      period('per-1', 'fe-internet', '2026-10-28', 120_000, 'acc-1'),
      // Próximo en 3 días (31 oct)
      period('per-2', 'fe-gym', '2026-10-31', 90_000, 'acc-1'),
      // Próximo en el límite exacto de 7 días (3 nov)
      period('per-3', 'fe-rent', '2026-11-03', 600_000, 'acc-1'),
      // Fuera de la ventana de 7 días (4 nov)
      period('per-out', 'fe-rent', '2026-11-04', 500_000, 'acc-1'),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods,
      selectedAccountIds: new Set(['acc-1']),
      now: mockNow,
    })

    expect(result.upcomingPaymentsNotice).not.toBeNull()
    expect(result.upcomingPaymentsNotice?.count).toBe(3)
    expect(result.upcomingPaymentsNotice?.totalAmount).toBe(810_000n) // 120k + 90k + 600k
    expect(result.upcomingPaymentsNotice?.windowStart).toBe('2026-10-28')
    expect(result.upcomingPaymentsNotice?.windowEnd).toBe('2026-11-03')
  })

  it('detecta saldo insuficiente en una cuenta frente a sus compromisos próximos', () => {
    // Cuenta acc-2 tiene saldo 200.000
    // Compromisos en acc-2: 250.000
    const fixedExpensePeriods = [
      period('per-insufficient', 'fe-rent', '2026-10-30', 250_000, 'acc-2'),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods,
      selectedAccountIds: new Set(['acc-2']),
      now: mockNow,
    })

    expect(result.insufficientBalanceNotices).toHaveLength(1)
    const notice = result.insufficientBalanceNotices[0]
    expect(notice.accountName).toBe('Davivienda')
    expect(notice.currentBalance).toBe(200_000n)
    expect(notice.requiredAmount).toBe(250_000n)
    expect(notice.deficitAmount).toBe(50_000n)
    expect(notice.description).toContain('Faltan')
    expect(notice.description).toContain('50.000')
    expect(notice.description).toContain('completar los pagos')
  })

  it('indica cobertura holgada cuando el saldo es suficiente, aclarando que no es dinero garantizado', () => {
    // Cuenta acc-1 tiene saldo 1.000.000
    // Compromisos: 300.000
    const fixedExpensePeriods = [
      period('per-covered', 'fe-rent', '2026-10-30', 300_000, 'acc-1'),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods,
      selectedAccountIds: new Set(['acc-1']),
      now: mockNow,
    })

    expect(result.insufficientBalanceNotices).toHaveLength(0)
    expect(result.upcomingPaymentsNotice?.coveredAccounts).toHaveLength(1)
    const covered = result.upcomingPaymentsNotice?.coveredAccounts[0]
    expect(covered?.currentBalance).toBe(1_000_000n)
    expect(covered?.commitmentsAmount).toBe(300_000n)
    expect(covered?.remainingEstimatedBalance).toBe(700_000n)
  })

  it('identifica obligaciones sin cuenta sugerida sin asignarlas arbitrariamente', () => {
    const fixedExpensePeriods = [
      period('per-no-acc', 'fe-internet', '2026-10-29', 150_000, null), // suggested_account_id = null
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods,
      selectedAccountIds: new Set(['acc-1', 'acc-2']),
      now: mockNow,
    })

    expect(result.upcomingPaymentsNotice?.unassignedItems).toHaveLength(1)
    expect(result.upcomingPaymentsNotice?.unassignedTotalAmount).toBe(150_000n)
    expect(result.upcomingPaymentsNotice?.unassignedItems[0].name).toBe('Internet Fibra')
  })

  it('respeta la selección de una sola cuenta filtrando obligaciones ajenas pero manteniendo las sin cuenta asignada', () => {
    const fixedExpensePeriods = [
      period('per-acc1', 'fe-rent', '2026-10-29', 300_000, 'acc-1'),
      period('per-acc2', 'fe-gym', '2026-10-30', 100_000, 'acc-2'), // De otra cuenta
      period('per-unassigned', 'fe-internet', '2026-10-31', 80_000, null), // Sin cuenta asignada
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods,
      selectedAccountIds: new Set(['acc-1']), // Solo acc-1
      now: mockNow,
    })

    // Debe incluir la de acc-1 y la no asignada (2 en total)
    expect(result.upcomingPaymentsNotice?.count).toBe(2)
    expect(result.upcomingPaymentsNotice?.totalAmount).toBe(380_000n)
    expect(result.upcomingPaymentsNotice?.coveredAccounts).toHaveLength(1)
    expect(result.upcomingPaymentsNotice?.coveredAccounts[0].commitmentsAmount).toBe(300_000n) // Solo la suya
    expect(result.upcomingPaymentsNotice?.unassignedItems).toHaveLength(1)
    expect(result.upcomingPaymentsNotice?.unassignedItems[0].name).toBe('Internet Fibra')
    expect(result.upcomingPaymentsNotice?.description).toContain('no tiene cuenta sugerida asignada')
  })

  it('respeta un período personalizado en las categorías principales y mantiene datos anteriores para comparar', () => {
    const transactions = [
      // Movimiento en agosto
      transaction('tx-aug-food', 'expense', 200_000, '2026-08-10', 'acc-1', { category_id: 'cat-food' }),
      transaction('tx-aug-serv', 'expense', 50_000, '2026-08-12', 'acc-1', { category_id: 'cat-services' }),
      // Movimientos de septiembre y octubre (fuera del filtro personalizado de agosto)
      transaction('tx-sep', 'expense', 400_000, '2026-09-10', 'acc-1', { category_id: 'cat-food' }),
      transaction('tx-oct', 'expense', 600_000, '2026-10-10', 'acc-1', { category_id: 'cat-food' }),
    ]

    const result = generateFinancialSuggestions({
      accounts,
      transactions, // Contiene todo el historial
      categories,
      fixedExpenses: [],
      fixedExpensePeriods: [],
      selectedAccountIds: new Set(['acc-1']),
      dateFrom: '2026-08-01',
      dateTo: '2026-08-31',
      now: mockNow,
    })

    // Las categorías con mayor gasto deben corresponder al período de agosto seleccionado (250.000 total)
    expect(result.cashFlowSummaryNotice?.expense).toBe(250_000n)
    expect(result.topCategories).toHaveLength(2)
    expect(result.topCategories[0].categoryName).toBe('Alimentación')
    expect(result.topCategories[0].amount).toBe(200_000n)
    expect(result.topCategories[0].percentage).toBe(80)
    expect(result.topCategories[1].categoryName).toBe('Servicios')
    expect(result.topCategories[1].amount).toBe(50_000n)
    expect(result.topCategories[1].percentage).toBe(20)

    // Pero la comparación histórica con el mes anterior sigue disponiendo de los datos de septiembre
    expect(result.expenseComparisonNotice?.previousPeriod.expense).toBe(400_000n)
  })

  it('recalcula al cambiar de día en Bogotá mediante parámetro today', () => {
    const fixedExpensePeriods = [
      period('per-due-today', 'fe-rent', '2026-10-28', 500_000, 'acc-1'),
    ]

    // En 2026-10-28 la obligación vence hoy (próxima)
    const resultToday = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods,
      selectedAccountIds: new Set(['acc-1']),
      today: '2026-10-28',
    })
    expect(resultToday.overdueNotice).toBeNull()
    expect(resultToday.upcomingPaymentsNotice?.count).toBe(1)

    // Al avanzar a medianoche del 2026-10-29, pasa a estar vencida
    const resultTomorrow = generateFinancialSuggestions({
      accounts,
      transactions: [],
      categories,
      fixedExpenses: fixedExpensesList,
      fixedExpensePeriods,
      selectedAccountIds: new Set(['acc-1']),
      today: '2026-10-29',
    })
    expect(resultTomorrow.overdueNotice).not.toBeNull()
    expect(resultTomorrow.overdueNotice?.count).toBe(1)
    expect(resultTomorrow.upcomingPaymentsNotice).toBeNull()
  })
})
