export type AccountType = 'cash' | 'bank' | 'wallet'
export type TransactionKind = 'income' | 'expense' | 'transfer'

export interface FinancialAccount {
  id: string
  user_id: string
  name: string
  account_type: AccountType
  currency: 'COP'
  initial_balance: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface FinancialTransaction {
  id: string
  user_id: string
  kind: TransactionKind
  account_id: string
  destination_account_id: string | null
  amount: number
  occurred_on: string
  category_id: string | null
  description: string | null
  client_request_id: string
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface AccountInput {
  name: string
  account_type: AccountType
  initial_balance: number
}

export interface TransactionInput {
  kind: TransactionKind
  account_id: string
  destination_account_id: string | null
  amount: number
  occurred_on: string
  category_id: string | null
  description: string | null
}

export interface FinancialCategory {
  id: string
  user_id: string
  kind: Exclude<TransactionKind, 'transfer'>
  parent_id: string | null
  name: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface CategoryInput {
  kind: Exclude<TransactionKind, 'transfer'>
  parent_id: string | null
  name: string
}
