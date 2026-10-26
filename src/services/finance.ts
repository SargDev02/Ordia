import { supabase } from './supabase'
import type { AccountInput, CategoryInput, FinancialAccount, FinancialCategory, FinancialTransaction, TransactionInput } from '../types/finance'

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

  const [accountsResult, categoriesResult, transactionsResult] = await Promise.all([
    api.from('financial_accounts').select('*').order('created_at'),
    api.from('financial_categories').select('*').order('kind').order('parent_id', { nullsFirst: true }).order('name'),
    api.from('financial_transactions').select('*').is('deleted_at', null).order('occurred_on', { ascending: false }).order('created_at', { ascending: false }),
  ])

  if (accountsResult.error) fail('No pudimos cargar tus cuentas.')
  if (categoriesResult.error) fail('No pudimos cargar tus categorías.')
  if (transactionsResult.error) fail('No pudimos cargar tus movimientos.')

  return {
    accounts: accountsResult.data as FinancialAccount[],
    categories: categoriesResult.data as FinancialCategory[],
    transactions: transactionsResult.data as FinancialTransaction[],
  }
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
