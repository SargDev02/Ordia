import type { AccountType, TransactionKind } from '../types/finance'

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  bank: 'Banco',
  cash: 'Efectivo',
  wallet: 'Billetera',
}

export const TRANSACTION_KIND_LABELS: Record<TransactionKind, string> = {
  expense: 'Gasto',
  income: 'Ingreso',
  transfer: 'Transferencia',
}
