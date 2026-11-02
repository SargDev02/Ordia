import type { FinancialAccount, FinancialCategory, FinancialTransaction, TransactionKind } from '../types/finance'

export function calculateAccountBalance(
  account: FinancialAccount,
  transactions: FinancialTransaction[],
) {
  let balance = BigInt(account.initial_balance)

  for (const transaction of transactions) {
    if (transaction.deleted_at) continue
    const amount = BigInt(transaction.amount)

    if (transaction.kind === 'income' && transaction.account_id === account.id) balance += amount
    if (transaction.kind === 'expense' && transaction.account_id === account.id) balance -= amount
    if (transaction.kind === 'transfer') {
      if (transaction.account_id === account.id) balance -= amount
      if (transaction.destination_account_id === account.id) balance += amount
    }
  }

  return balance
}

export function getBogotaToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'America/Bogota',
    year: 'numeric',
  }).formatToParts(now)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function getBogotaMonthBounds(now = new Date()) {
  const today = getBogotaToday(now)
  const [year, month] = today.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  }
}

export function normalizeCategorySearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[→>]/g, ' ')
    .replace(/\s+/g, ' ')
}

/**
 * Expande las categorías seleccionadas: elegir una categoría principal incluye
 * tanto sus movimientos directos como los de sus subcategorías; elegir solo una
 * subcategoría conserva únicamente esa subcategoría.
 */
export function expandSelectedCategoryIds(
  selectedIds: ReadonlySet<string>,
  categories: FinancialCategory[],
): Set<string> {
  const expanded = new Set<string>(selectedIds)
  if (selectedIds.size === 0) return expanded

  let added = true
  while (added) {
    added = false
    for (const category of categories) {
      if (category.parent_id && expanded.has(category.parent_id) && !expanded.has(category.id)) {
        expanded.add(category.id)
        added = true
      }
    }
  }

  return expanded
}

export interface TransactionFilters {
  accountIds: ReadonlySet<string>
  dateFrom?: string
  dateTo?: string
  kind?: TransactionKind | ''
  categoryIds?: ReadonlySet<string> | null
}

export function filterTransactions(transactions: FinancialTransaction[], filters: TransactionFilters) {
  if (filters.accountIds.size === 0) return []
  return transactions.filter((transaction) => {
    if (transaction.deleted_at) return false
    if (!filters.accountIds.has(transaction.account_id)
      && (!transaction.destination_account_id || !filters.accountIds.has(transaction.destination_account_id))) return false
    if (filters.kind && transaction.kind !== filters.kind) return false
    if (filters.dateFrom && transaction.occurred_on < filters.dateFrom) return false
    if (filters.dateTo && transaction.occurred_on > filters.dateTo) return false
    if (filters.categoryIds !== undefined && filters.categoryIds !== null) {
      if (!transaction.category_id || !filters.categoryIds.has(transaction.category_id)) return false
    }
    return true
  })
}

export function getCategoryLabel(categoryId: string | null, categories: FinancialCategory[]) {
  if (!categoryId) return 'Transferencia'
  const category = categories.find((item) => item.id === categoryId)
  if (!category) return 'Categoría no disponible'
  const parent = category.parent_id ? categories.find((item) => item.id === category.parent_id) : null
  return parent ? `${parent.name} > ${category.name}` : category.name
}

export function calculatePeriodSummary(
  transactions: FinancialTransaction[],
  categories: FinancialCategory[],
  filters: TransactionFilters,
  now = new Date(),
) {
  const month = getBogotaMonthBounds(now)
  const start = filters.dateFrom || month.start
  const end = filters.dateTo || month.end
  let income = 0n
  let expense = 0n
  const expensesByCategory = new Map<string, bigint>()
  const categoriesById = new Map(categories.map((category) => [category.id, category]))

  for (const transaction of filterTransactions(transactions, {
    accountIds: filters.accountIds,
    kind: filters.kind,
    dateFrom: start,
    dateTo: end,
  })) {
    const amount = BigInt(transaction.amount)
    if (transaction.kind === 'income') income += amount
    if (transaction.kind === 'expense') {
      expense += amount
      const category = transaction.category_id ? categoriesById.get(transaction.category_id) : null
      const rootId = category?.parent_id ?? category?.id ?? 'unavailable'
      expensesByCategory.set(rootId, (expensesByCategory.get(rootId) ?? 0n) + amount)
    }
  }

  return { income, expense, expensesByCategory, start, end }
}

export function calculateMonthlySummary(transactions: FinancialTransaction[], now = new Date()) {
  const accountIds = new Set<string>()
  for (const transaction of transactions) {
    accountIds.add(transaction.account_id)
    if (transaction.destination_account_id) accountIds.add(transaction.destination_account_id)
  }
  return calculatePeriodSummary(transactions, [], { accountIds }, now)
}

export function formatCop(amount: bigint | number) {
  return new Intl.NumberFormat('es-CO', {
    currency: 'COP',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(amount)
}
