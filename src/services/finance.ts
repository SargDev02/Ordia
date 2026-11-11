import { supabase } from './supabase'
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

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

function fail(message: string): never {
  throw new Error(message)
}

export function isMissingBankInboxSchemaError(
  error: { code?: string; message?: string; details?: string } | null | undefined,
): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === '42883' || error.code === 'PGRST205' || error.code === 'PGRST202') {
    return true
  }
  const combined = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase()
  return combined.includes('does not exist') || combined.includes('schema cache')
}

export async function fetchFinanceData() {
  const api = client()
  const defaultsResult = await api.rpc('ensure_default_financial_categories')
  if (defaultsResult.error) fail('No pudimos preparar tus categorías financieras.')
  const generationResult = await api.rpc('generate_fixed_expense_periods', { p_horizon_months: 3 })
  if (generationResult.error) fail('No pudimos actualizar los períodos de tus gastos fijos.')

  const [
    accountsResult,
    categoriesResult,
    transactionsResult,
    fixedExpensesResult,
    fixedExpenseVersionsResult,
    fixedExpensePeriodsResult,
    bankNotificationsResult,
    cardLinksResult,
    bankEmailAliasResult,
  ] = await Promise.all([
    api.from('financial_accounts').select('*').order('created_at'),
    api.from('financial_categories').select('*').order('kind').order('parent_id', { nullsFirst: true }).order('name'),
    api.from('financial_transactions').select('*').is('deleted_at', null).order('occurred_on', { ascending: false }).order('created_at', { ascending: false }),
    api.from('fixed_expenses').select('*').order('created_at'),
    api.from('fixed_expense_versions').select('*').order('effective_from'),
    api.from('fixed_expense_periods').select('*').order('due_date'),
    api.from('bank_notifications').select('*').order('occurred_on', { ascending: false }).order('occurred_time', { ascending: false }),
    api.from('bank_card_account_links').select('*'),
    api.from('bank_email_aliases').select('*').eq('is_current', true).maybeSingle(),
  ])

  if (accountsResult.error) fail('No pudimos cargar tus cuentas.')
  if (categoriesResult.error) fail('No pudimos cargar tus categorías.')
  if (transactionsResult.error) fail('No pudimos cargar tus movimientos.')
  if (fixedExpensesResult.error || fixedExpenseVersionsResult.error || fixedExpensePeriodsResult.error) fail('No pudimos cargar tus gastos fijos.')

  const missingNotificationsSchema = isMissingBankInboxSchemaError(bankNotificationsResult.error)
  const missingLinksSchema = isMissingBankInboxSchemaError(cardLinksResult.error)
  const missingEmailAliasSchema = isMissingBankInboxSchemaError(bankEmailAliasResult.error)

  if (bankNotificationsResult.error && !missingNotificationsSchema) {
    fail('No pudimos cargar tus avisos bancarios.')
  }
  if (cardLinksResult.error && !missingLinksSchema) {
    fail('No pudimos cargar los enlaces de tarjetas.')
  }
  if (bankEmailAliasResult.error && !missingEmailAliasSchema) {
    fail('No pudimos cargar la conexión de correo bancario.')
  }

  const bankInboxAvailable = !missingNotificationsSchema && !missingLinksSchema
  const bankEmailAvailable = bankInboxAvailable && !missingEmailAliasSchema

  return {
    accounts: accountsResult.data as FinancialAccount[],
    categories: categoriesResult.data as FinancialCategory[],
    transactions: transactionsResult.data as FinancialTransaction[],
    fixedExpenses: fixedExpensesResult.data as FixedExpense[],
    fixedExpenseVersions: fixedExpenseVersionsResult.data as FixedExpenseVersion[],
    fixedExpensePeriods: fixedExpensePeriodsResult.data as FixedExpensePeriod[],
    bankInboxAvailable,
    bankEmailAvailable,
    bankEmailAlias: bankEmailAvailable ? ((bankEmailAliasResult.data as BankEmailAlias | null) ?? null) : null,
    bankNotifications: bankInboxAvailable ? ((bankNotificationsResult.data ?? []) as BankNotification[]) : [],
    cardAccountLinks: bankInboxAvailable ? ((cardLinksResult.data ?? []) as BankCardAccountLink[]) : [],
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
  if (input.kind === 'adjustment') {
    const { error } = await client().rpc('create_balance_adjustment', {
      p_request_id: requestId,
      p_account_id: input.account_id,
      p_direction: input.adjustment_direction,
      p_amount: input.amount,
      p_occurred_on: input.occurred_on,
      p_description: input.description,
    })
    if (error) fail('No pudimos registrar el ajuste. Comprueba la cuenta y vuelve a intentarlo.')
    return
  }
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
  const { error } = await client().from('financial_transactions').update({
    ...input, adjustment_direction: input.kind === 'adjustment' ? input.adjustment_direction : null,
  }).eq('id', transactionId)
  if (error) fail('No pudimos actualizar el movimiento.')
}

export async function deleteTransaction(transactionId: string) {
  const { error } = await client().from('financial_transactions').update({ deleted_at: new Date().toISOString() }).eq('id', transactionId)
  if (error) fail('No pudimos eliminar el movimiento.')
}

export async function createBankNotification(requestId: string, input: CreateBankNotificationInput): Promise<BankNotification> {
  const { data, error } = await client().rpc('create_movement_notice', {
    p_account_last_digits: input.account_last_digits ?? null,
    p_amount: input.amount,
    p_bank_name: input.bank_name ?? 'Bancolombia',
    p_card_last_digits: input.card_last_digits ?? null,
    p_card_type: input.card_type ?? null,
    p_counterparty_account_last_digits: input.counterparty_account_last_digits ?? null,
    p_counterparty_name: input.counterparty_name ?? null,
    p_merchant: input.merchant ?? null,
    p_notification_type: input.notification_type,
    p_occurred_on: input.occurred_on,
    p_occurred_time: input.occurred_time,
    p_provider_reference: input.provider_reference ?? null,
    p_correspondent_name: input.correspondent_name ?? null,
    p_municipality: input.municipality ?? null,
    p_request_id: requestId,
    p_source_channel: input.source_channel ?? 'manual',
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La bandeja «Movimientos por revisar» no está disponible porque falta instalar su migración en la base de datos. No se guardó ningún pendiente.')
  }
  if (error) fail('No pudimos guardar el aviso bancario pendiente.')
  const created = data as BankNotification | null
  if (!created || typeof created.id !== 'string' || !created.id) {
    fail('No recibimos confirmación del servidor. No se guardó ningún pendiente.')
  }
  return created
}

export async function confirmBankNotificationAsTransaction(
  notificationId: string,
  requestId: string,
  input: ConfirmNotificationTransactionInput,
) {
  const { data, error } = await client().rpc('confirm_bank_notification_as_transaction', {
    p_account_id: input.account_id,
    p_category_id: input.category_id,
    p_description: input.description,
    p_identifier_type: input.identifier_type ?? null,
    p_kind: input.kind,
    p_last_digits: input.last_digits ?? null,
    p_notification_id: notificationId,
    p_occurred_on: input.occurred_on,
    p_remember_link: input.remember_link ?? false,
    p_request_id: requestId,
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La bandeja «Movimientos por revisar» no está disponible en la base de datos. No se registró el movimiento.')
  }
  if (error) fail(error.message || 'No pudimos registrar el movimiento desde el aviso.')
  const created = data as FinancialTransaction | null
  if (!created || typeof created.id !== 'string') {
    fail('No recibimos confirmación del movimiento registrado.')
  }
}

export async function confirmBankNotificationAsTransfer(
  notificationId: string,
  requestId: string,
  input: ConfirmNotificationTransferInput,
) {
  const { data, error } = await client().rpc('confirm_bank_notification_as_transfer', {
    p_account_id: input.account_id,
    p_description: input.description,
    p_destination_account_id: input.destination_account_id,
    p_identifier_type: input.identifier_type ?? null,
    p_last_digits: input.last_digits ?? null,
    p_notification_id: notificationId,
    p_occurred_on: input.occurred_on,
    p_remember_link: input.remember_link ?? false,
    p_request_id: requestId,
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La bandeja «Movimientos por revisar» no está disponible en la base de datos. No se registró la transferencia.')
  }
  if (error) fail(error.message || 'No pudimos registrar la transferencia desde el aviso.')
  const created = data as FinancialTransaction | null
  if (!created || typeof created.id !== 'string') {
    fail('No recibimos confirmación de la transferencia registrada.')
  }
}

export async function linkBankNotificationToTransaction(notificationId: string, transactionId: string) {
  const { error } = await client().rpc('link_bank_notification_to_transaction', {
    p_notification_id: notificationId,
    p_transaction_id: transactionId,
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La bandeja «Movimientos por revisar» no está disponible en la base de datos. No se vinculó el aviso.')
  }
  if (error) fail(error.message || 'No pudimos vincular el aviso al movimiento.')
}

export async function dismissBankNotification(notificationId: string) {
  const { error } = await client().rpc('dismiss_bank_notification', {
    p_notification_id: notificationId,
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La bandeja «Movimientos por revisar» no está disponible en la base de datos. No se descartó el aviso.')
  }
  if (error) fail(error.message || 'No pudimos descartar el aviso.')
}

export async function saveCardAccountLink(
  identifierType: 'card' | 'account',
  lastDigits: string,
  accountId: string,
) {
  const { error } = await client().rpc('upsert_card_account_link', {
    p_account_id: accountId,
    p_identifier_type: identifierType,
    p_last_digits: lastDigits,
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La bandeja «Movimientos por revisar» no está disponible en la base de datos.')
  }
  if (error) fail(error.message || 'No pudimos guardar la asociación de tarjeta o cuenta.')
}

export async function ensureOrReplaceBankEmailAlias(replace = false): Promise<BankEmailAlias> {
  const { data, error } = await client().rpc('ensure_or_replace_bank_email_alias', {
    p_replace: replace,
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La recepción automática por correo aún no está instalada en la base de datos.')
  }
  if (error) fail(error.message || 'No pudimos generar la dirección privada de recepción.')
  const created = data as BankEmailAlias | null
  if (!created || typeof created.id !== 'string') {
    fail('No recibimos confirmación del servidor al generar la dirección privada.')
  }
  return created
}

export async function confirmBankEmailAlias(aliasId: string): Promise<BankEmailAlias> {
  const { data, error } = await client().rpc('confirm_bank_email_alias', {
    p_alias_id: aliasId,
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La recepción automática por correo aún no está instalada en la base de datos.')
  }
  if (error) fail(error.message || 'No pudimos marcar la dirección como confirmada.')
  const confirmed = data as BankEmailAlias | null
  if (!confirmed || typeof confirmed.id !== 'string') {
    fail('No recibimos confirmación del servidor al activar la dirección.')
  }
  return confirmed
}

export async function disableBankEmailAlias(aliasId: string): Promise<BankEmailAlias> {
  const { data, error } = await client().rpc('disable_bank_email_alias', {
    p_alias_id: aliasId,
  })
  if (isMissingBankInboxSchemaError(error)) {
    fail('La recepción automática por correo aún no está instalada en la base de datos.')
  }
  if (error) fail(error.message || 'No pudimos desactivar la dirección de recepción.')
  const disabled = data as BankEmailAlias | null
  if (!disabled || typeof disabled.id !== 'string') {
    fail('No recibimos confirmación del servidor al desactivar la dirección.')
  }
  return disabled
}
