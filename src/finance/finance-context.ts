import { createContext } from 'react'
import type { AccountInput, CategoryInput, FinancialAccount, FinancialCategory, FinancialTransaction, TransactionInput } from '../types/finance'

export type RealtimeStatus = 'connecting' | 'connected' | 'offline'

export interface FinanceContextValue {
  accounts: FinancialAccount[]
  categories: FinancialCategory[]
  error: string
  isLoading: boolean
  realtimeStatus: RealtimeStatus
  transactions: FinancialTransaction[]
  archiveAccount: (accountId: string) => Promise<void>
  archiveCategory: (categoryId: string) => Promise<void>
  createAccount: (input: AccountInput) => Promise<void>
  createCategory: (input: CategoryInput) => Promise<void>
  createTransaction: (requestId: string, input: TransactionInput) => Promise<void>
  deleteTransaction: (transactionId: string) => Promise<void>
  refresh: () => Promise<void>
  renameCategory: (categoryId: string, name: string) => Promise<void>
  updateAccount: (accountId: string, input: AccountInput) => Promise<void>
  updateTransaction: (transactionId: string, input: TransactionInput) => Promise<void>
}

export const FinanceContext = createContext<FinanceContextValue | null>(null)
