import { createContext } from 'react'
import type {
  AccountInput,
  BankCardAccountLink,
  BankEmailAlias,
  BankNotification,
  CategoryInput,
  ConfirmNotificationTransactionInput,
  ConfirmNotificationTransferInput,
  CreateBankNotificationInput,
  FinancialAccount,
  FinancialCategory,
  FinancialTransaction,
  FixedExpense,
  FixedExpenseInput,
  FixedExpensePaymentInput,
  FixedExpensePeriod,
  FixedExpenseVersion,
  TransactionInput,
} from '../types/finance'

export type RealtimeStatus = 'connecting' | 'connected' | 'offline'

export interface FinanceContextValue {
  accounts: FinancialAccount[]
  categories: FinancialCategory[]
  fixedExpenses: FixedExpense[]
  fixedExpensePeriods: FixedExpensePeriod[]
  fixedExpenseVersions: FixedExpenseVersion[]
  bankInboxAvailable?: boolean
  bankEmailAvailable?: boolean
  bankEmailAlias?: BankEmailAlias | null
  bankNotifications: BankNotification[]
  cardAccountLinks: BankCardAccountLink[]
  error: string
  isLoading: boolean
  realtimeStatus: RealtimeStatus
  transactions: FinancialTransaction[]
  archiveAccount: (accountId: string) => Promise<void>
  archiveCategory: (categoryId: string) => Promise<void>
  createAccount: (input: AccountInput) => Promise<void>
  createCategory: (input: CategoryInput) => Promise<void>
  createTransaction: (requestId: string, input: TransactionInput) => Promise<void>
  createFixedExpense: (requestId: string, input: FixedExpenseInput) => Promise<void>
  deleteTransaction: (transactionId: string) => Promise<void>
  pauseFixedExpense: (fixedExpenseId: string) => Promise<void>
  payFixedExpensePeriod: (periodId: string, requestId: string, input: FixedExpensePaymentInput) => Promise<void>
  reactivateFixedExpense: (fixedExpenseId: string, nextDueDate: string) => Promise<void>
  removeFixedExpense: (fixedExpenseId: string) => Promise<void>
  refresh: () => Promise<void>
  renameCategory: (categoryId: string, name: string) => Promise<void>
  updateAccount: (accountId: string, input: AccountInput) => Promise<void>
  updateTransaction: (transactionId: string, input: TransactionInput) => Promise<void>
  updateFixedExpense: (fixedExpenseId: string, input: FixedExpenseInput) => Promise<void>
  undoFixedExpensePayment: (periodId: string) => Promise<void>
  createBankNotification: (input: CreateBankNotificationInput) => Promise<BankNotification>
  confirmBankNotificationAsTransaction: (notificationId: string, requestId: string, input: ConfirmNotificationTransactionInput) => Promise<void>
  confirmBankNotificationAsTransfer: (notificationId: string, requestId: string, input: ConfirmNotificationTransferInput) => Promise<void>
  linkBankNotificationToTransaction: (notificationId: string, transactionId: string) => Promise<void>
  dismissBankNotification: (notificationId: string) => Promise<void>
  saveCardAccountLink: (identifierType: 'card' | 'account', lastDigits: string, accountId: string) => Promise<void>
  ensureOrReplaceBankEmailAlias?: (replace?: boolean) => Promise<BankEmailAlias>
  confirmBankEmailAlias?: (aliasId: string) => Promise<BankEmailAlias>
  disableBankEmailAlias?: (aliasId: string) => Promise<BankEmailAlias>
}

export const FinanceContext = createContext<FinanceContextValue | null>(null)
