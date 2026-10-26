import { describe, expect, it } from 'vitest'
import { calculateAccountBalance, calculatePeriodSummary, filterTransactions, getBogotaMonthBounds, getCategoryLabel } from './calculations'
import type { FinancialAccount, FinancialCategory, FinancialTransaction, TransactionKind } from '../types/finance'

function account(id: string, initialBalance = 0): FinancialAccount {
  return {
    account_type: 'bank', archived_at: null, created_at: '', currency: 'COP',
    id, initial_balance: initialBalance, name: id, updated_at: '', user_id: 'user-a',
  }
}

function transaction(id: string, kind: TransactionKind, amount: number, overrides: Partial<FinancialTransaction> = {}): FinancialTransaction {
  return {
    account_id: 'account-a', amount, category_id: kind === 'transfer' ? null : `${kind}-root`,
    client_request_id: id, created_at: '', deleted_at: null,
    description: null, destination_account_id: kind === 'transfer' ? 'account-b' : null,
    id, kind, occurred_on: '2026-10-15', updated_at: '', user_id: 'user-a', ...overrides,
  }
}

function category(id: string, name: string, kind: 'income' | 'expense', parentId: string | null = null): FinancialCategory {
  return { archived_at: null, created_at: '', id, kind, name, parent_id: parentId, updated_at: '', user_id: 'user-a' }
}

const categories = [
  category('income-root', 'Trabajo', 'income'),
  category('expense-root', 'Alimentación', 'expense'),
  category('expense-child', 'Restaurantes', 'expense', 'expense-root'),
]

describe('cálculos financieros exactos', () => {
  it('separa saldo inicial, ingresos y gastos', () => {
    const transactions = [transaction('income', 'income', 1_000), transaction('expense', 'expense', 250)]
    expect(calculateAccountBalance(account('account-a', 500), transactions)).toBe(1_250n)
    const summary = calculatePeriodSummary(transactions, categories, { accountIds: new Set(['account-a']) }, new Date('2026-10-20T12:00:00Z'))
    expect(summary.income).toBe(1_000n)
    expect(summary.expense).toBe(250n)
  })

  it('aplica una transferencia como una unidad simétrica sin contarla en reportes', () => {
    const transfer = transaction('transfer', 'transfer', 300)
    expect(calculateAccountBalance(account('account-a', 1_000), [transfer])).toBe(700n)
    expect(calculateAccountBalance(account('account-b', 200), [transfer])).toBe(500n)
    const summary = calculatePeriodSummary([transfer], categories, { accountIds: new Set(['account-a', 'account-b']) }, new Date('2026-10-20T12:00:00Z'))
    expect(summary.income).toBe(0n)
    expect(summary.expense).toBe(0n)
  })

  it('recalcula correctamente tras editar o eliminar un movimiento', () => {
    const original = transaction('expense', 'expense', 100)
    const edited = { ...original, amount: 175 }
    const deleted = { ...edited, deleted_at: '2026-10-21T00:00:00Z' }

    expect(calculateAccountBalance(account('account-a', 500), [original])).toBe(400n)
    expect(calculateAccountBalance(account('account-a', 500), [edited])).toBe(325n)
    expect(calculateAccountBalance(account('account-a', 500), [deleted])).toBe(500n)
  })

  it('calcula el mes con America/Bogota cerca del cambio UTC', () => {
    expect(getBogotaMonthBounds(new Date('2026-11-01T04:30:00Z'))).toEqual({
      start: '2026-10-01',
      end: '2026-10-31',
    })
  })

  it('mantiene la asociación y el rótulo cuando una categoría se renombra', () => {
    const renamed = categories.map((item) => item.id === 'expense-root' ? { ...item, name: 'Comida' } : item)
    expect(getCategoryLabel('expense-child', renamed)).toBe('Comida > Restaurantes')
  })

  it('agrupa subcategorías una sola vez bajo la categoría principal', () => {
    const rows = [transaction('one', 'expense', 100, { category_id: 'expense-child' }), transaction('two', 'expense', 50)]
    const summary = calculatePeriodSummary(rows, categories, { accountIds: new Set(['account-a']) }, new Date('2026-10-20T12:00:00Z'))
    expect(summary.expensesByCategory.get('expense-root')).toBe(150n)
    expect(summary.expensesByCategory.size).toBe(1)
  })

  it('distingue todas, varias, una y ninguna cuenta sin duplicar transferencias', () => {
    const rows = [transaction('a', 'income', 100), transaction('b', 'expense', 20, { account_id: 'account-b' }), transaction('t', 'transfer', 30)]
    expect(filterTransactions(rows, { accountIds: new Set(['account-a', 'account-b']) })).toHaveLength(3)
    expect(filterTransactions(rows, { accountIds: new Set(['account-a']) })).toHaveLength(2)
    expect(filterTransactions(rows, { accountIds: new Set(['account-b']) })).toHaveLength(2)
    expect(filterTransactions(rows, { accountIds: new Set() })).toHaveLength(0)
  })

  it('combina cuentas, fechas y tipo', () => {
    const rows = [transaction('included', 'expense', 20), transaction('wrong-type', 'income', 40), transaction('wrong-date', 'expense', 50, { occurred_on: '2026-09-30' })]
    expect(filterTransactions(rows, { accountIds: new Set(['account-a']), dateFrom: '2026-10-01', dateTo: '2026-10-31', kind: 'expense' }).map((row) => row.id)).toEqual(['included'])
  })
})
