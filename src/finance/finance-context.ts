import { createContext } from 'react'
import type { AccountInput, CategoryInput, FinancialAccount, FinancialCategory, FinancialTransaction, FixedExpense, FixedExpenseInput, FixedExpensePaymentInput, FixedExpensePeriod, FixedExpenseVersion, TransactionInput } from '../types/finance'

export type RealtimeStatus = 'connecting' | 'connected' | 'offline'

export interface FinanceContextValue {
  accounts: FinancialAccount[]
  categories: FinancialCategory[]
  fixedExpenses: FixedExpense[]
  fixedExpensePeriods: FixedExpensePeriod[]
  fixedExpenseVersions: FixedExpenseVersion[]
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
}

export const FinanceContext = createContext<FinanceContextValue | null>(null)
