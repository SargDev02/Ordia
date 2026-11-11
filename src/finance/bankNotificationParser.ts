import type {
  BankCardAccountLink,
  BankNotification,
  FinancialAccount,
  FinancialTransaction,
  ParseNotificationResult,
} from '../types/finance'
import {
  parseBancolombiaNotification as parseSharedBancolombiaNotification,
  parsePseReceipt,
  parseCopAmount,
  parseCopAmountDetailed,
  type CopAmountParseOutcome,
} from '../../supabase/functions/_shared/bank-email/parser'
import { htmlToSafePlainText } from '../../supabase/functions/_shared/bank-email/mime-and-auth'

export { parseCopAmount, parseCopAmountDetailed, type CopAmountParseOutcome }

/**
 * Parsea el texto copiado o recibido de una notificación bancaria de Bancolombia.
 *
 * Extrae estrictamente los datos presentes (tipo, importe entero exacto, fecha, hora, comercio,
 * cuenta o tarjeta) sin inventar información no suministrada ni redondear centavos.
 */
export function parseBancolombiaNotification(rawText: string): ParseNotificationResult {
  return parseSharedBancolombiaNotification(rawText)
}

export function parseMovementNotice(rawText: string): ParseNotificationResult {
  const plainText = /<\/?[a-z][^>]*>/i.test(rawText) ? htmlToSafePlainText(rawText) : rawText
  return /Estado\s+de\s+la\s+Transacci[oó]n\s*:/i.test(plainText)
    ? parsePseReceipt(plainText)
    : parseSharedBancolombiaNotification(plainText)
}

/**
 * Resuelve la cuenta de Ordia asociada explícitamente por el usuario a la tarjeta o cuenta del aviso.
 * No inventa asociaciones por nombre para mantener coherencia exacta con la validación del servidor.
 */
export function resolveKnownAccountId(
  notification: Pick<BankNotification, 'user_id' | 'card_last_digits' | 'account_last_digits'>,
  cardAccountLinks: BankCardAccountLink[],
  accounts: FinancialAccount[],
): string | null {
  const ownedAccountIds = new Set(
    accounts.filter((acc) => acc.user_id === notification.user_id).map((acc) => acc.id),
  )

  if (notification.card_last_digits) {
    const cardLink = cardAccountLinks.find(
      (link) =>
        link.user_id === notification.user_id &&
        link.identifier_type === 'card' &&
        link.last_digits === notification.card_last_digits,
    )
    if (cardLink && ownedAccountIds.has(cardLink.account_id)) {
      return cardLink.account_id
    }
  }

  if (notification.account_last_digits) {
    const accountLink = cardAccountLinks.find(
      (link) =>
        link.user_id === notification.user_id &&
        link.identifier_type === 'account' &&
        link.last_digits === notification.account_last_digits,
    )
    if (accountLink && ownedAccountIds.has(accountLink.account_id)) {
      return accountLink.account_id
    }
  }

  return null
}

/**
 * Valida si un movimiento financiero existente es elegible para «Ya lo registré»:
 * mismo propietario, movimiento vigente, importe exacto, tipo/sentido compatible y
 * cuenta coincidente cuando se conozca (origen en salidas y destino en entradas para transferencias propias).
 */
export function isTransactionCompatibleWithNotification(
  transaction: FinancialTransaction,
  notification: Pick<BankNotification, 'user_id' | 'notification_type' | 'amount'>,
  knownAccountId: string | null,
): boolean {
  if (transaction.deleted_at) return false
  if (transaction.user_id !== notification.user_id) return false
  if (transaction.amount !== notification.amount) return false
  if (notification.notification_type === 'cash_deposit_received') {
    return transaction.kind === 'income' && (!knownAccountId || transaction.account_id === knownAccountId)
  }

  if (notification.notification_type === 'purchase') {
    if (transaction.kind !== 'expense') return false
    if (knownAccountId && transaction.account_id !== knownAccountId) return false
    return true
  }

  if (notification.notification_type === 'transfer_sent') {
    if (transaction.kind !== 'expense' && transaction.kind !== 'transfer') return false
    // Tanto en gasto como en transferencia propia de salida, account_id representa la cuenta de origen
    if (knownAccountId && transaction.account_id !== knownAccountId) return false
    return true
  }

  // transfer_received
  if (transaction.kind !== 'income' && transaction.kind !== 'transfer') return false
  if (knownAccountId) {
    if (transaction.kind === 'income' && transaction.account_id !== knownAccountId) return false
    if (transaction.kind === 'transfer' && transaction.destination_account_id !== knownAccountId) return false
  }
  return true
}
