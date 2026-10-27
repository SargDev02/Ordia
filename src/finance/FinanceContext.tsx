import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/useAuth'
import { supabase } from '../services/supabase'
import {
  archiveAccount as archiveAccountRequest,
  archiveCategory as archiveCategoryRequest,
  createAccount as createAccountRequest,
  createCategory as createCategoryRequest,
  createTransaction as createTransactionRequest,
  createFixedExpense as createFixedExpenseRequest,
  deleteTransaction as deleteTransactionRequest,
  fetchFinanceData,
  pauseFixedExpense as pauseFixedExpenseRequest,
  payFixedExpensePeriod as payFixedExpensePeriodRequest,
  reactivateFixedExpense as reactivateFixedExpenseRequest,
  removeFixedExpense as removeFixedExpenseRequest,
  renameCategory as renameCategoryRequest,
  updateAccount as updateAccountRequest,
  updateTransaction as updateTransactionRequest,
  updateFixedExpense as updateFixedExpenseRequest,
  undoFixedExpensePayment as undoFixedExpensePaymentRequest,
} from '../services/finance'
import type { FinancialAccount, FinancialCategory, FinancialTransaction, FixedExpense, FixedExpensePeriod, FixedExpenseVersion } from '../types/finance'
import { FinanceContext, type FinanceContextValue, type RealtimeStatus } from './finance-context'

export function FinanceProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [categories, setCategories] = useState<FinancialCategory[]>([])
  const [transactions, setTransactions] = useState<FinancialTransaction[]>([])
  const [fixedExpenses, setFixedExpenses] = useState<FixedExpense[]>([])
  const [fixedExpensePeriods, setFixedExpensePeriods] = useState<FixedExpensePeriod[]>([])
  const [fixedExpenseVersions, setFixedExpenseVersions] = useState<FixedExpenseVersion[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting')
  const loadSequence = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current
    if (!userId) return

    try {
      const data = await fetchFinanceData()
      if (sequence !== loadSequence.current) return
      setAccounts(data.accounts)
      setCategories(data.categories)
      setTransactions(data.transactions)
      setFixedExpenses(data.fixedExpenses)
      setFixedExpensePeriods(data.fixedExpensePeriods)
      setFixedExpenseVersions(data.fixedExpenseVersions)
      setError('')
    } catch (caught) {
      if (sequence !== loadSequence.current) return
      setError(caught instanceof Error ? caught.message : 'No pudimos actualizar tus datos.')
    } finally {
      if (sequence === loadSequence.current) setIsLoading(false)
    }
  }, [userId])

  useEffect(() => {
    // La sincronización inicial proviene de Supabase y debe poblar el contexto al montarlo.
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    void refresh()

    const activeClient = supabase
    if (!activeClient || !userId) return

    const scheduleRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => void refresh(), 120)
    }

    const filter = `user_id=eq.${userId}`
    const channel = activeClient
      .channel(`finance:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'financial_accounts', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'financial_accounts', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'financial_categories', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'financial_categories', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'financial_transactions', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'financial_transactions', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fixed_expenses', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'fixed_expenses', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fixed_expense_versions', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'fixed_expense_versions', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fixed_expense_periods', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'fixed_expense_periods', filter }, scheduleRefresh)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('connected')
          void refresh()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeStatus('offline')
        }
      })

    return () => {
      loadSequence.current += 1
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      void activeClient.removeChannel(channel)
    }
  }, [refresh, userId])

  const runAndRefresh = useCallback(async (operation: () => Promise<void>) => {
    setError('')
    await operation()
    await refresh()
  }, [refresh])

  const value = useMemo<FinanceContextValue>(() => ({
    accounts,
    categories,
    fixedExpenses,
    fixedExpensePeriods,
    fixedExpenseVersions,
    error,
    isLoading,
    realtimeStatus,
    transactions,
    refresh,
    createAccount: (input) => runAndRefresh(() => createAccountRequest(userId, input)),
    updateAccount: (accountId, input) => runAndRefresh(() => updateAccountRequest(accountId, input)),
    archiveAccount: (accountId) => runAndRefresh(() => archiveAccountRequest(accountId)),
    createCategory: (input) => runAndRefresh(() => createCategoryRequest(userId, input)),
    renameCategory: (categoryId, name) => runAndRefresh(() => renameCategoryRequest(categoryId, name)),
    archiveCategory: (categoryId) => runAndRefresh(() => archiveCategoryRequest(categoryId)),
    createTransaction: (requestId, input) => runAndRefresh(() => createTransactionRequest(requestId, input)),
    createFixedExpense: (requestId, input) => runAndRefresh(() => createFixedExpenseRequest(requestId, input)),
    updateFixedExpense: (fixedExpenseId, input) => runAndRefresh(() => updateFixedExpenseRequest(fixedExpenseId, input)),
    pauseFixedExpense: (fixedExpenseId) => runAndRefresh(() => pauseFixedExpenseRequest(fixedExpenseId)),
    reactivateFixedExpense: (fixedExpenseId, nextDueDate) => runAndRefresh(() => reactivateFixedExpenseRequest(fixedExpenseId, nextDueDate)),
    removeFixedExpense: (fixedExpenseId) => runAndRefresh(() => removeFixedExpenseRequest(fixedExpenseId)),
    payFixedExpensePeriod: (periodId, requestId, input) => runAndRefresh(() => payFixedExpensePeriodRequest(periodId, requestId, input)),
    undoFixedExpensePayment: (periodId) => runAndRefresh(() => undoFixedExpensePaymentRequest(periodId)),
    updateTransaction: (transactionId, input) => runAndRefresh(() => updateTransactionRequest(transactionId, input)),
    deleteTransaction: (transactionId) => runAndRefresh(() => deleteTransactionRequest(transactionId)),
  }), [accounts, categories, error, fixedExpensePeriods, fixedExpenseVersions, fixedExpenses, isLoading, realtimeStatus, refresh, runAndRefresh, transactions, userId])

  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>
}
