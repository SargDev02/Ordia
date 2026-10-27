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

export type FixedExpenseFrequency = 'monthly' | 'annual'
export type FixedExpenseStatus = 'active' | 'paused' | 'deleted'

export interface FixedExpense {
  id: string
  user_id: string
  client_request_id: string
  name: string
  notes: string | null
  status: FixedExpenseStatus
  paused_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface FixedExpenseVersion {
  id: string
  user_id: string
  fixed_expense_id: string
  effective_from: string
  expected_amount: number
  currency: 'COP'
  category_id: string
  suggested_account_id: string | null
  frequency: FixedExpenseFrequency
  anchor_date: string
  superseded_at: string | null
  created_at: string
}

export interface FixedExpensePeriod {
  id: string
  user_id: string
  fixed_expense_id: string
  version_id: string
  due_date: string
  expected_amount: number
  currency: 'COP'
  category_id: string
  suggested_account_id: string | null
  transaction_id: string | null
  payment_request_id: string | null
  paid_amount: number | null
  paid_on: string | null
  paid_account_id: string | null
  paid_category_id: string | null
  paid_at: string | null
  cancelled_at: string | null
  cancellation_reason: 'paused' | 'deleted' | 'superseded' | null
  created_at: string
  updated_at: string
}

export interface FixedExpenseInput {
  name: string
  expected_amount: number
  category_id: string
  suggested_account_id: string | null
  frequency: FixedExpenseFrequency
  anchor_date: string
  effective_from: string
  notes: string | null
}

export interface FixedExpensePaymentInput {
  account_id: string
  category_id: string
  paid_on: string
  amount: number
}
