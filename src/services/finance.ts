import { supabase } from './supabase'
import type { AccountInput, CategoryInput, FinancialAccount, FinancialCategory, FinancialTransaction, FixedExpense, FixedExpenseInput, FixedExpensePaymentInput, FixedExpensePeriod, FixedExpenseVersion, TransactionInput } from '../types/finance'

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

function fail(message: string): never {
  throw new Error(message)
}

export async function fetchFinanceData() {
  const api = client()
  const defaultsResult = await api.rpc('ensure_default_financial_categories')
  if (defaultsResult.error) fail('No pudimos preparar tus categorías financieras.')
  const generationResult = await api.rpc('generate_fixed_expense_periods', { p_horizon_months: 3 })
  if (generationResult.error) fail('No pudimos actualizar los períodos de tus gastos fijos.')

  const [accountsResult, categoriesResult, transactionsResult, fixedExpensesResult, fixedExpenseVersionsResult, fixedExpensePeriodsResult] = await Promise.all([
    api.from('financial_accounts').select('*').order('created_at'),
    api.from('financial_categories').select('*').order('kind').order('parent_id', { nullsFirst: true }).order('name'),
    api.from('financial_transactions').select('*').is('deleted_at', null).order('occurred_on', { ascending: false }).order('created_at', { ascending: false }),
    api.from('fixed_expenses').select('*').order('created_at'),
    api.from('fixed_expense_versions').select('*').order('effective_from'),
    api.from('fixed_expense_periods').select('*').order('due_date'),
  ])

  if (accountsResult.error) fail('No pudimos cargar tus cuentas.')
  if (categoriesResult.error) fail('No pudimos cargar tus categorías.')
  if (transactionsResult.error) fail('No pudimos cargar tus movimientos.')
  if (fixedExpensesResult.error || fixedExpenseVersionsResult.error || fixedExpensePeriodsResult.error) fail('No pudimos cargar tus gastos fijos.')

  return {
    accounts: accountsResult.data as FinancialAccount[],
    categories: categoriesResult.data as FinancialCategory[],
    transactions: transactionsResult.data as FinancialTransaction[],
    fixedExpenses: fixedExpensesResult.data as FixedExpense[],
    fixedExpenseVersions: fixedExpenseVersionsResult.data as FixedExpenseVersion[],
    fixedExpensePeriods: fixedExpensePeriodsResult.data as FixedExpensePeriod[],
  }
}

export async function createFixedExpense(requestId: string, input: FixedExpenseInput) {
  const { error } = await client().rpc('create_fixed_expense', {
    p_category_id: input.category_id,
    p_expected_amount: input.expected_amount,
    p_first_due_date: input.anchor_date,
    p_frequency: input.frequency,
    p_name: input.name,
    p_notes: input.notes,
    p_request_id: requestId,
    p_suggested_account_id: input.suggested_account_id,
  })
  if (error) fail('No pudimos crear el gasto fijo. Revisa la categoría, la cuenta y las fechas.')
}

export async function updateFixedExpense(fixedExpenseId: string, input: FixedExpenseInput) {
  const { error } = await client().rpc('update_fixed_expense', {
    p_anchor_date: input.anchor_date,
    p_category_id: input.category_id,
    p_effective_from: input.effective_from,
    p_expected_amount: input.expected_amount,
    p_fixed_expense_id: fixedExpenseId,
    p_frequency: input.frequency,
    p_name: input.name,
    p_notes: input.notes,
    p_suggested_account_id: input.suggested_account_id,
  })
  if (error) fail('No pudimos aplicar los cambios. La fecha efectiva no puede reescribir obligaciones vencidas.')
}

export async function pauseFixedExpense(fixedExpenseId: string) {
  const { error } = await client().rpc('pause_fixed_expense', { p_fixed_expense_id: fixedExpenseId })
  if (error) fail('No pudimos pausar el gasto fijo.')
}

export async function reactivateFixedExpense(fixedExpenseId: string, nextDueDate: string) {
  const { error } = await client().rpc('reactivate_fixed_expense', { p_fixed_expense_id: fixedExpenseId, p_next_due_date: nextDueDate })
  if (error) fail('No pudimos reactivar el gasto fijo. Revisa el próximo vencimiento.')
}

export async function removeFixedExpense(fixedExpenseId: string) {
  const { error } = await client().rpc('delete_fixed_expense', { p_fixed_expense_id: fixedExpenseId })
  if (error) fail('No pudimos dar de baja el gasto fijo.')
}

export async function payFixedExpensePeriod(periodId: string, requestId: string, input: FixedExpensePaymentInput) {
  const { error } = await client().rpc('pay_fixed_expense_period', {
    p_account_id: input.account_id,
    p_amount: input.amount,
    p_category_id: input.category_id,
    p_paid_on: input.paid_on,
    p_period_id: periodId,
    p_request_id: requestId,
  })
  if (error) fail('No pudimos registrar el pago. Comprueba que la cuenta y la categoría estén activas.')
}

export async function undoFixedExpensePayment(periodId: string) {
  const { error } = await client().rpc('undo_fixed_expense_payment', { p_period_id: periodId })
  if (error) fail('No pudimos deshacer el pago.')
}

export async function createAccount(userId: string, input: AccountInput) {
  const { error } = await client().from('financial_accounts').insert({
    ...input,
    currency: 'COP',
    user_id: userId,
  })
  if (error) fail('No pudimos crear la cuenta. Revisa los datos e inténtalo de nuevo.')
}

export async function updateAccount(accountId: string, input: AccountInput) {
  const { error } = await client().from('financial_accounts').update(input).eq('id', accountId)
  if (error) fail('No pudimos actualizar la cuenta.')
}

export async function archiveAccount(accountId: string) {
  const { error } = await client().from('financial_accounts').update({ archived_at: new Date().toISOString() }).eq('id', accountId)
  if (error) fail('No pudimos archivar la cuenta.')
}

export async function createTransaction(requestId: string, input: TransactionInput) {
  const { error } = await client().rpc('create_financial_transaction', {
    p_account_id: input.account_id,
    p_amount: input.amount,
    p_category_id: input.category_id,
    p_description: input.description,
    p_destination_account_id: input.destination_account_id,
    p_kind: input.kind,
    p_occurred_on: input.occurred_on,
    p_request_id: requestId,
  })
  if (error) fail('No pudimos registrar el movimiento. Comprueba las cuentas y vuelve a intentarlo.')
}

export async function createCategory(userId: string, input: CategoryInput) {
  const { error } = await client().from('financial_categories').insert({ ...input, user_id: userId })
  if (error?.code === '23505') fail('Ya existe una categoría con ese nombre en este nivel.')
  if (error) fail('No pudimos crear la categoría. Revisa el nombre y vuelve a intentarlo.')
}

export async function renameCategory(categoryId: string, name: string) {
  const { error } = await client().from('financial_categories').update({ name }).eq('id', categoryId)
  if (error?.code === '23505') fail('Ya existe una categoría con ese nombre en este nivel.')
  if (error) fail('No pudimos renombrar la categoría.')
}

export async function archiveCategory(categoryId: string) {
  const { error } = await client().from('financial_categories').update({ archived_at: new Date().toISOString() }).eq('id', categoryId)
  if (error) fail('No pudimos archivar la categoría.')
}

export async function updateTransaction(transactionId: string, input: TransactionInput) {
  const { error } = await client().from('financial_transactions').update(input).eq('id', transactionId)
  if (error) fail('No pudimos actualizar el movimiento.')
}

export async function deleteTransaction(transactionId: string) {
  const { error } = await client().from('financial_transactions').update({ deleted_at: new Date().toISOString() }).eq('id', transactionId)
  if (error) fail('No pudimos eliminar el movimiento.')
}
