import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/useAuth'
import { supabase } from '../services/supabase'
import {
  archiveAccount as archiveAccountRequest,
  archiveCategory as archiveCategoryRequest,
  confirmBankEmailAlias as confirmBankEmailAliasRequest,
  confirmBankNotificationAsTransaction as confirmBankNotificationAsTransactionRequest,
  confirmBankNotificationAsTransfer as confirmBankNotificationAsTransferRequest,
  createAccount as createAccountRequest,
  createBankNotification as createBankNotificationRequest,
  createCategory as createCategoryRequest,
  createTransaction as createTransactionRequest,
  createFixedExpense as createFixedExpenseRequest,
  deleteTransaction as deleteTransactionRequest,
  disableBankEmailAlias as disableBankEmailAliasRequest,
  dismissBankNotification as dismissBankNotificationRequest,
  ensureOrReplaceBankEmailAlias as ensureOrReplaceBankEmailAliasRequest,
  fetchFinanceData,
  linkBankNotificationToTransaction as linkBankNotificationToTransactionRequest,
  pauseFixedExpense as pauseFixedExpenseRequest,
  payFixedExpenseFromBankNotice as payFixedExpenseFromBankNoticeRequest,
  payFixedExpensePeriod as payFixedExpensePeriodRequest,
  reactivateFixedExpense as reactivateFixedExpenseRequest,
  removeFixedExpense as removeFixedExpenseRequest,
  renameCategory as renameCategoryRequest,
  saveCardAccountLink as saveCardAccountLinkRequest,
  updateAccount as updateAccountRequest,
  updateTransaction as updateTransactionRequest,
  updateFixedExpense as updateFixedExpenseRequest,
  undoFixedExpensePayment as undoFixedExpensePaymentRequest,
} from '../services/finance'
import type {
  BankCardAccountLink,
  BankEmailAlias,
  BankNotification,
  FinancialAccount,
  FinancialCategory,
  FinancialTransaction,
  FixedExpense,
  FixedExpensePeriod,
  FixedExpenseVersion,
} from '../types/finance'
import { FinanceContext, type FinanceContextValue, type RealtimeStatus } from './finance-context'

const PREPARE_INTERVAL_MS = 6 * 60 * 60 * 1000
// Se guarda fuera del componente para que navegar entre Inicio y Gastos fijos no repita la preparación.
let lastPreparation: { userId: string; at: number } | null = null

export function FinanceProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const userId = session?.user.id ?? ''
  const [loadedUserId, setLoadedUserId] = useState('')
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [categories, setCategories] = useState<FinancialCategory[]>([])
  const [transactions, setTransactions] = useState<FinancialTransaction[]>([])
  const [fixedExpenses, setFixedExpenses] = useState<FixedExpense[]>([])
  const [fixedExpensePeriods, setFixedExpensePeriods] = useState<FixedExpensePeriod[]>([])
  const [fixedExpenseVersions, setFixedExpenseVersions] = useState<FixedExpenseVersion[]>([])
  const [bankInboxAvailable, setBankInboxAvailable] = useState(true)
  const [bankEmailAvailable, setBankEmailAvailable] = useState(true)
  const [bankEmailAlias, setBankEmailAlias] = useState<BankEmailAlias | null>(null)
  const [bankNotifications, setBankNotifications] = useState<BankNotification[]>([])
  const [cardAccountLinks, setCardAccountLinks] = useState<BankCardAccountLink[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting')
  const loadSequence = useRef(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback(async () => {
    const sequence = ++loadSequence.current
    if (!userId) return

    // Las funciones de preparación escriben en la base: se piden al abrir la sesión
    // y luego como máximo cada PREPARE_INTERVAL_MS, no en cada foco o aviso.
    const previous = lastPreparation
    const prepare = !previous || previous.userId !== userId || Date.now() - previous.at > PREPARE_INTERVAL_MS

    try {
      const data = await fetchFinanceData({ prepare })
      if (prepare) lastPreparation = { userId, at: Date.now() }
      if (sequence !== loadSequence.current) return
      setLoadedUserId(userId)
      setAccounts(data.accounts)
      setCategories(data.categories)
      setTransactions(data.transactions)
      setFixedExpenses(data.fixedExpenses)
      setFixedExpensePeriods(data.fixedExpensePeriods)
      setFixedExpenseVersions(data.fixedExpenseVersions)
      setBankInboxAvailable(data.bankInboxAvailable)
      setBankEmailAvailable(data.bankEmailAvailable)
      setBankEmailAlias(data.bankEmailAlias)
      setBankNotifications(data.bankNotifications)
      setCardAccountLinks(data.cardAccountLinks)
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

    const refreshWhenVisible = () => { if (document.visibilityState !== 'hidden') scheduleRefresh() }
    window.addEventListener('focus', refreshWhenVisible)
    window.addEventListener('online', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    // Realtime solo escucha los avisos bancarios: son lo único que crea el servidor
    // (correo del banco) sin una acción del usuario en esta pestaña. Lo demás se
    // recarga después de cada mutación y al volver a la pestaña (foco/visibilidad).
    const filter = `user_id=eq.${userId}`
    let subscribedOnce = false
    const channel = activeClient
      .channel(`finance:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'bank_notifications', filter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bank_notifications', filter }, scheduleRefresh)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('connected')
          // La primera suscripción coincide con la carga inicial; solo se recarga al reconectar.
          if (subscribedOnce) scheduleRefresh()
          subscribedOnce = true
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeStatus('offline')
        }
      })

    return () => {
      loadSequence.current += 1
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      window.removeEventListener('focus', refreshWhenVisible)
      window.removeEventListener('online', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      void activeClient.removeChannel(channel)
    }
  }, [refresh, userId])

  const runAndRefresh = useCallback(async (operation: () => Promise<void>) => {
    setError('')
    await operation()
    await refresh()
  }, [refresh])

  const value = useMemo<FinanceContextValue>(() => ({
    accounts: loadedUserId === userId ? accounts : [],
    categories: loadedUserId === userId ? categories : [],
    fixedExpenses: loadedUserId === userId ? fixedExpenses : [],
    fixedExpensePeriods: loadedUserId === userId ? fixedExpensePeriods : [],
    fixedExpenseVersions: loadedUserId === userId ? fixedExpenseVersions : [],
    error,
    isLoading,
    realtimeStatus,
    transactions: loadedUserId === userId ? transactions : [],
    bankInboxAvailable,
    bankEmailAvailable,
    bankEmailAlias: loadedUserId === userId ? bankEmailAlias : null,
    bankNotifications: loadedUserId === userId ? bankNotifications : [],
    cardAccountLinks: loadedUserId === userId ? cardAccountLinks : [],
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
    payFixedExpenseFromBankNotice: (noticeId, periodId, requestId, input) => runAndRefresh(() => payFixedExpenseFromBankNoticeRequest(noticeId, periodId, requestId, input)),
    payFixedExpensePeriod: (periodId, requestId, input) => runAndRefresh(() => payFixedExpensePeriodRequest(periodId, requestId, input)),
    undoFixedExpensePayment: (periodId) => runAndRefresh(() => undoFixedExpensePaymentRequest(periodId)),
    updateTransaction: (transactionId, input) => runAndRefresh(() => updateTransactionRequest(transactionId, input)),
    deleteTransaction: (transactionId) => runAndRefresh(() => deleteTransactionRequest(transactionId)),
    createBankNotification: async (input) => {
      setError('')
      const result = await createBankNotificationRequest(crypto.randomUUID(), input)
      await refresh()
      return result
    },
    confirmBankNotificationAsTransaction: (notificationId, requestId, input) =>
      runAndRefresh(() => confirmBankNotificationAsTransactionRequest(notificationId, requestId, input)),
    confirmBankNotificationAsTransfer: (notificationId, requestId, input) =>
      runAndRefresh(() => confirmBankNotificationAsTransferRequest(notificationId, requestId, input)),
    linkBankNotificationToTransaction: (notificationId, transactionId) =>
      runAndRefresh(() => linkBankNotificationToTransactionRequest(notificationId, transactionId)),
    dismissBankNotification: (notificationId) =>
      runAndRefresh(() => dismissBankNotificationRequest(notificationId)),
    saveCardAccountLink: (identifierType, lastDigits, accountId) =>
      runAndRefresh(() => saveCardAccountLinkRequest(identifierType, lastDigits, accountId)),
    ensureOrReplaceBankEmailAlias: async (replace = false) => {
      setError('')
      const result = await ensureOrReplaceBankEmailAliasRequest(replace)
      await refresh()
      return result
    },
    confirmBankEmailAlias: async (aliasId) => {
      setError('')
      const result = await confirmBankEmailAliasRequest(aliasId)
      await refresh()
      return result
    },
    disableBankEmailAlias: async (aliasId) => {
      setError('')
      const result = await disableBankEmailAliasRequest(aliasId)
      await refresh()
      return result
    },
  }), [accounts, bankEmailAlias, bankEmailAvailable, bankInboxAvailable, bankNotifications, cardAccountLinks, categories, error, fixedExpensePeriods, fixedExpenseVersions, fixedExpenses, isLoading, realtimeStatus, refresh, runAndRefresh, transactions, userId, loadedUserId])

  return <FinanceContext.Provider value={value}>{children}</FinanceContext.Provider>
}
