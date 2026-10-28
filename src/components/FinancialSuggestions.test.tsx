import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { FinancialSuggestions } from './FinancialSuggestions'
import type { FinancialSuggestionsResult } from '../finance/suggestions'

function renderComponent(suggestions: FinancialSuggestionsResult) {
  return render(
    <MemoryRouter>
      <FinancialSuggestions suggestions={suggestions} />
    </MemoryRouter>,
  )
}

describe('componente FinancialSuggestions', () => {
  it('muestra estado vacío cuando no hay cuentas seleccionadas', () => {
    const emptyResult: FinancialSuggestionsResult = {
      hasAccountsSelected: false,
      scope: {
        accountNames: [],
        accountCount: 0,
        isAllAccounts: false,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
      },
      overdueNotice: null,
      insufficientBalanceNotices: [],
      upcomingPaymentsNotice: null,
      expenseComparisonNotice: null,
      cashFlowSummaryNotice: null,
      topCategories: [],
      emptyReason: 'no_accounts',
    }

    renderComponent(emptyResult)
    expect(screen.getByText('Selecciona cuentas para ver sugerencias')).toBeInTheDocument()
    expect(
      screen.getByText(/Selecciona una o varias cuentas en los filtros superiores/i),
    ).toBeInTheDocument()
  })

  it('muestra estado cuando no hay datos suficientes en el alcance', () => {
    const noDataResult: FinancialSuggestionsResult = {
      hasAccountsSelected: true,
      scope: {
        accountNames: ['Bancolombia'],
        accountCount: 1,
        isAllAccounts: false,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
      },
      overdueNotice: null,
      insufficientBalanceNotices: [],
      upcomingPaymentsNotice: null,
      expenseComparisonNotice: null,
      cashFlowSummaryNotice: null,
      topCategories: [],
      emptyReason: 'no_data',
    }

    renderComponent(noDataResult)
    expect(screen.getByText('Sin datos suficientes en este alcance')).toBeInTheDocument()
  })

  it('muestra aviso prioritario de obligaciones vencidas con enlace a gastos fijos', () => {
    const overdueResult: FinancialSuggestionsResult = {
      hasAccountsSelected: true,
      scope: {
        accountNames: ['Bancolombia'],
        accountCount: 1,
        isAllAccounts: true,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
      },
      overdueNotice: {
        kind: 'overdue',
        title: '1 obligación fija vencida',
        totalAmount: 500_000n,
        count: 1,
        oldestDueDate: '2026-10-20',
        items: [
          {
            periodId: 'per-1',
            fixedExpenseId: 'fe-1',
            name: 'Arriendo',
            dueDate: '2026-10-20',
            expectedAmount: 500_000,
            suggestedAccountId: 'acc-1',
            suggestedAccountName: 'Bancolombia',
          },
        ],
        description: 'Tienes 1 obligación pendiente por $ 500.000 con vencimiento anterior a hoy.',
      },
      insufficientBalanceNotices: [],
      upcomingPaymentsNotice: null,
      expenseComparisonNotice: null,
      cashFlowSummaryNotice: null,
      topCategories: [],
      emptyReason: null,
    }

    renderComponent(overdueResult)
    expect(screen.getByText('1 obligación fija vencida')).toBeInTheDocument()
    expect(screen.getByText('Arriendo')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Gestionar en Gastos fijos/i })).toHaveAttribute(
      'href',
      '/gastos-fijos',
    )
  })

  it('muestra aviso de saldo insuficiente y aclara que no se mueven fondos automáticamente', () => {
    const insufficientResult: FinancialSuggestionsResult = {
      hasAccountsSelected: true,
      scope: {
        accountNames: ['Davivienda'],
        accountCount: 1,
        isAllAccounts: false,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
      },
      overdueNotice: null,
      insufficientBalanceNotices: [
        {
          kind: 'insufficient_balance',
          accountId: 'acc-2',
          accountName: 'Davivienda',
          currentBalance: 100_000n,
          requiredAmount: 250_000n,
          deficitAmount: 150_000n,
          commitmentsCount: 1,
          windowStart: '2026-10-28',
          windowEnd: '2026-11-03',
          items: [
            {
              periodId: 'per-1',
              name: 'Internet',
              dueDate: '2026-10-30',
              expectedAmount: 250_000,
              isOverdue: false,
            },
          ],
          description: 'El saldo actual registrado no cubre los compromisos.',
        },
      ],
      upcomingPaymentsNotice: null,
      expenseComparisonNotice: null,
      cashFlowSummaryNotice: null,
      topCategories: [],
      emptyReason: null,
    }

    renderComponent(insufficientResult)
    expect(
      screen.getByText(/Davivienda: pagos pendientes superan el saldo registrado/i),
    ).toBeInTheDocument()
    expect(screen.getByText(/Déficit estimado/i)).toBeInTheDocument()
    expect(screen.getByText('Vencidos y próximos 7 días')).toBeInTheDocument()
    expect(screen.getByText(/obligaciones impagas vencidas y las próximas entre/)).toBeInTheDocument()
    expect(
      screen.getByText(/Ordia no anticipa ingresos futuros ni mueve dinero automáticamente/i),
    ).toBeInTheDocument()
  })

  it('muestra pagos próximos, comparación de gastos y categorías con participación', () => {
    const fullResult: FinancialSuggestionsResult = {
      hasAccountsSelected: true,
      scope: {
        accountNames: ['Bancolombia'],
        accountCount: 1,
        isAllAccounts: true,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
      },
      overdueNotice: null,
      insufficientBalanceNotices: [],
      upcomingPaymentsNotice: {
        kind: 'upcoming_payments',
        windowStart: '2026-10-28',
        windowEnd: '2026-11-03',
        totalAmount: 120_000n,
        count: 1,
        coveredAccounts: [
          {
            accountId: 'acc-1',
            accountName: 'Bancolombia',
            currentBalance: 1_000_000n,
            commitmentsAmount: 120_000n,
            remainingEstimatedBalance: 880_000n,
          },
        ],
        unassignedItems: [],
        unassignedTotalAmount: 0n,
        description: 'Tienes 1 pago programado en los próximos 7 días.',
      },
      expenseComparisonNotice: {
        kind: 'expense_comparison',
        currentPeriod: {
          start: '2026-10-01',
          end: '2026-10-28',
          expense: 400_000n,
          daysElapsed: 28,
        },
        previousPeriod: {
          start: '2026-09-01',
          end: '2026-09-28',
          expense: 300_000n,
          daysElapsed: 28,
          monthName: 'septiembre',
          year: 2026,
        },
        adjustmentExplanation: 'Comparación entre los primeros 28 días.',
        hasPreviousData: true,
        differenceAmount: 100_000n,
        percentageChange: 33.33,
        topCategories: [
          {
            categoryId: 'cat-1',
            categoryName: 'Alimentación',
            amount: 300_000n,
            percentage: 75,
          },
        ],
        description: 'Los gastos registrados aumentaron un 33.3%.',
      },
      cashFlowSummaryNotice: {
        kind: 'cash_flow_summary',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        income: 1_000_000n,
        expense: 400_000n,
        net: 600_000n,
        description: 'Superávit de 600.000.',
      },
      topCategories: [
        {
          categoryId: 'cat-1',
          categoryName: 'Alimentación',
          amount: 300_000n,
          percentage: 75,
        },
      ],
      emptyReason: null,
    }

    renderComponent(fullResult)
    expect(screen.getByText(/Pagos próximos \(2026-10-28 a 2026-11-03\)/i)).toBeInTheDocument()
    expect(screen.getByText(/Análisis de gastos frente al mes anterior/i)).toBeInTheDocument()
    expect(screen.getByText('Alimentación')).toBeInTheDocument()
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText(/Flujo neto del período/i)).toBeInTheDocument()
  })
})
