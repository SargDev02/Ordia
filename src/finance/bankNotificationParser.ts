import type {
  BankCardAccountLink,
  BankNotification,
  BankNotificationType,
  FinancialAccount,
  FinancialTransaction,
  ParseNotificationResult,
} from '../types/finance'

const MAX_SAFE_COP_AMOUNT = 9_000_000_000_000

export type CopAmountParseOutcome =
  | { ok: true; amount: number }
  | { ok: false; error: string }

/**
 * Valida y convierte estrictamente un importe en pesos colombianos (COP) enteros.
 *
 * Reglas:
 * - Reconoce enteros sin separadores ("22000"), separadores de miles con punto ("50.000", "39.900,00")
 *   o con coma ("22,000", "200,000.00"), y centavos explícitos únicamente cuando son cero (",00" o ".00").
 * - Rechaza centavos distintos de cero, separadores mezclados o inválidos y valores fuera de rango.
 * - Nunca redondea ni trunca silenciosamente.
 */
export function parseCopAmountDetailed(raw: string): CopAmountParseOutcome {
  const clean = raw.trim().replace(/^COP\s*/i, '').replace(/^\$\s*/, '').trim()
  if (!clean) {
    return { ok: false, error: 'No pudimos encontrar el importe en pesos del aviso.' }
  }

  if (clean.startsWith('-')) {
    return { ok: false, error: `El importe «$${clean}» no puede ser negativo.` }
  }

  if (!/^[\d.,]+$/.test(clean)) {
    return {
      ok: false,
      error: `El importe «$${clean}» contiene caracteres o espacios inválidos. Usa únicamente dígitos y separadores válidos.`,
    }
  }

  // Detectar sufijo decimal explícito de 1 o 2 dígitos al final (ej. ,50 | .25 | ,5 | .0)
  // Nota: un grupo de 3 dígitos (.000 o ,000) es separador de miles en COP, no centavos.
  const decimalTailMatch = clean.match(/^(.+?)[.,](\d{1,2})$/)
  if (decimalTailMatch) {
    const intPart = decimalTailMatch[1]
    const decimalSeparator = clean[intPart.length]
    const centsPart = decimalTailMatch[2]

    if (centsPart.length !== 2) {
      return {
        ok: false,
        error: `El importe «$${clean}» tiene un formato decimal inválido o ambiguo («${decimalSeparator}${centsPart}»).`,
      }
    }

    if (centsPart !== '00') {
      return {
        ok: false,
        error: `El aviso incluye centavos distintos de cero («$${clean}»). Ordia registra únicamente pesos enteros y no redondea ni trunca importes.`,
      }
    }

    // Validar que la parte entera use el separador opuesto en grupos de 3, o ninguno
    const validIntWithCommaCents =
      decimalSeparator === ',' && (/^[1-9]\d*$/.test(intPart) || /^[1-9]\d{0,2}(?:\.\d{3})+$/.test(intPart))
    const validIntWithDotCents =
      decimalSeparator === '.' && (/^[1-9]\d*$/.test(intPart) || /^[1-9]\d{0,2}(?:,\d{3})+$/.test(intPart))

    if (!validIntWithCommaCents && !validIntWithDotCents) {
      if (/^0+$/.test(intPart.replace(/[.,]/g, ''))) {
        return { ok: false, error: 'El importe del aviso debe ser mayor que cero.' }
      }
      return {
        ok: false,
        error: `El importe «$${clean}» usa separadores de miles inválidos o ambiguos.`,
      }
    }

    const digitsOnly = intPart.replace(/[.,]/g, '')
    const amount = Number(digitsOnly)
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_SAFE_COP_AMOUNT) {
      return { ok: false, error: `El importe «$${clean}» está fuera del rango permitido en Ordia.` }
    }
    return { ok: true, amount }
  }

  // Sin parte de centavos: validar entero puro o grupos estrictos de miles (.000 o ,000)
  if (/^0+$/.test(clean.replace(/[.,]/g, ''))) {
    return { ok: false, error: 'El importe del aviso debe ser mayor que cero.' }
  }

  const isPlainInteger = /^[1-9]\d*$/.test(clean)
  const isDotThousands = /^[1-9]\d{0,2}(?:\.\d{3})+$/.test(clean)
  const isCommaThousands = /^[1-9]\d{0,2}(?:,\d{3})+$/.test(clean)

  if (!isPlainInteger && !isDotThousands && !isCommaThousands) {
    return {
      ok: false,
      error: `El importe «$${clean}» tiene separadores inválidos o es ambiguo. Revisa los puntos y comas del aviso.`,
    }
  }

  const digitsOnly = clean.replace(/[.,]/g, '')
  const amount = Number(digitsOnly)
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_SAFE_COP_AMOUNT) {
    return { ok: false, error: `El importe «$${clean}» está fuera del rango permitido en Ordia.` }
  }

  return { ok: true, amount }
}

/**
 * Parsea un importe en pesos colombianos (COP) enteros o retorna null si no es válido.
 */
export function parseCopAmount(raw: string): number | null {
  const outcome = parseCopAmountDetailed(raw)
  return outcome.ok ? outcome.amount : null
}

function isValidDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day <= lastDay
}

/**
 * Extrae el token de importe precedido por "$" detectando ambigüedades (varios importes o dígitos partidos por espacios).
 */
function extractSingleAmountToken(text: string): { ok: true; token: string } | { ok: false; error: string } {
  const dollarMatches = Array.from(
    text.matchAll(/\$\s*([^\s]+(?:\s+(?!\d{1,2}\/\d{1,2}\/)\d[^\s]*)*)/g),
  )

  if (dollarMatches.length === 0) {
    return { ok: false, error: 'No pudimos encontrar el importe en pesos del aviso.' }
  }

  if (dollarMatches.length > 1) {
    return {
      ok: false,
      error: 'El texto incluye varios importes en pesos y resulta ambiguo. Pega únicamente el aviso del movimiento que quieres revisar.',
    }
  }

  // Quitar puntuación final de oración (punto o coma simple al final del token, salvo separadores duplicados como "..")
  let token = dollarMatches[0][1].trim()
  if (/[.,]$/.test(token) && !/[.,]{2}$/.test(token)) {
    token = token.slice(0, -1)
  }

  return { ok: true, token }
}

/**
 * Parsea el texto copiado de una notificación bancaria de Bancolombia.
 *
 * Extrae estrictamente los datos presentes (tipo, importe entero exacto, fecha, hora, comercio,
 * cuenta o tarjeta) sin inventar información no suministrada ni redondear centavos.
 */
export function parseBancolombiaNotification(rawText: string): ParseNotificationResult {
  const text = rawText.trim()
  if (!text) {
    return {
      success: false,
      error: 'El texto del aviso está vacío. Pega la notificación de Bancolombia para revisarla.',
    }
  }

  // Validar mención o cabecera de Bancolombia
  const hasBancolombia = /bancolombia/i.test(text)
  if (!hasBancolombia) {
    return {
      success: false,
      error: 'No se reconoció un aviso de Bancolombia. Asegúrate de incluir el texto de la notificación bancaria.',
    }
  }

  // 1. Detectar tipo de operación
  let notificationType: BankNotificationType | null = null
  if (
    /recibiste\s+una\s+transferencia/i.test(text) ||
    /te\s+(?:hicieron|enviaron|transfirieron)\s+una\s+transferencia/i.test(text) ||
    /abono\s+de\s+transferencia/i.test(text)
  ) {
    notificationType = 'transfer_received'
  } else if (/compraste\s+/i.test(text) || /compra\s+por\s+/i.test(text) || /pago\s+en\s+/i.test(text)) {
    notificationType = 'purchase'
  } else if (/transferiste\s+/i.test(text) || /enviaste\s+una\s+transferencia/i.test(text)) {
    notificationType = 'transfer_sent'
  }

  if (!notificationType) {
    return {
      success: false,
      error: 'No pudimos identificar el tipo de aviso (compra, transferencia recibida o transferencia enviada).',
    }
  }

  // 2. Extraer y validar importe exacto en pesos COP enteros
  const tokenResult = extractSingleAmountToken(text)
  if (!tokenResult.ok) {
    return {
      success: false,
      error: tokenResult.error,
    }
  }

  const amountOutcome = parseCopAmountDetailed(tokenResult.token)
  if (!amountOutcome.ok) {
    return {
      success: false,
      error: amountOutcome.error,
    }
  }
  const parsedAmount = amountOutcome.amount

  // 3. Extraer fecha y hora en America/Bogota
  // Formatos habituales: "el 31/10/2026 a las 13:28" | "el 17/10/2026 a las 13:17" | "el 20/10/26 a las 21:15"
  const dateTimeMatch = text.match(
    /(?:el\s+)?(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[,\s]+(?:a\s+las\s+)?|\s+)(\d{1,2}):(\d{2})/i,
  )
  if (!dateTimeMatch) {
    return {
      success: false,
      error: 'No pudimos identificar la fecha y hora de la transacción en el aviso.',
    }
  }

  const rawDay = Number(dateTimeMatch[1])
  const rawMonth = Number(dateTimeMatch[2])
  let rawYear = Number(dateTimeMatch[3])
  if (rawYear < 100) {
    rawYear += 2000
  }
  const rawHour = Number(dateTimeMatch[4])
  const rawMinute = Number(dateTimeMatch[5])

  if (!isValidDate(rawYear, rawMonth, rawDay)) {
    return {
      success: false,
      error: `La fecha indicada (${dateTimeMatch[1]}/${dateTimeMatch[2]}/${dateTimeMatch[3]}) no corresponde a un día válido del calendario.`,
    }
  }

  if (rawHour < 0 || rawHour > 23 || rawMinute < 0 || rawMinute > 59) {
    return {
      success: false,
      error: `La hora indicada (${dateTimeMatch[4]}:${dateTimeMatch[5]}) no es válida.`,
    }
  }

  const occurred_on = `${rawYear}-${String(rawMonth).padStart(2, '0')}-${String(rawDay).padStart(2, '0')}`
  const occurred_time = `${String(rawHour).padStart(2, '0')}:${String(rawMinute).padStart(2, '0')}`

  // 4. Extraer comercio (solo para compras)
  let merchant: string | null = null
  if (notificationType === 'purchase') {
    const merchantMatch = text.match(
      /(?:en|a)\s+([A-Za-z0-9\s.,'&/_-]+?)(?=\s+con\s+tu|\s+el\s+\d|\s*,\s*el|\s*$)/i,
    )
    if (merchantMatch && merchantMatch[1]) {
      const cleanMerchant = merchantMatch[1].trim()
      if (cleanMerchant) {
        merchant = cleanMerchant
      }
    }
  }

  // 5. Extraer cuenta origen / destino
  let account_last_digits: string | null = null
  const accountMatch = text.match(/(?:en\s+tu\s+cuenta|desde\s+tu\s+cuenta|cuenta)\s+\*{1,2}(\d{3,8})/i)
  if (accountMatch && accountMatch[1]) {
    account_last_digits = accountMatch[1]
  }

  // 6. Extraer tarjeta y tipo (débito / crédito)
  let card_last_digits: string | null = null
  let card_type: 'debit' | 'credit' | null = null
  const debitCardMatch = text.match(/(?:T\.Deb|tarjeta\s+de\s+d[eé]bito)\s+\*+(\d{3,8})/i)
  const creditCardMatch = text.match(/(?:T\.Cred|tarjeta\s+de\s+cr[eé]dito)\s+\*+(\d{3,8})/i)
  const genericCardMatch = text.match(/tarjeta\s+\*+(\d{3,8})/i)

  if (debitCardMatch && debitCardMatch[1]) {
    card_last_digits = debitCardMatch[1]
    card_type = 'debit'
  } else if (creditCardMatch && creditCardMatch[1]) {
    card_last_digits = creditCardMatch[1]
    card_type = 'credit'
  } else if (genericCardMatch && genericCardMatch[1]) {
    card_last_digits = genericCardMatch[1]
  }

  // 7. Extraer contrapartes (remitente o cuenta destino ajena)
  let counterparty_name: string | null = null
  const senderMatch =
    text.match(/\bde\s+"([^"]*)"/i) ||
    text.match(/\bde\s+([A-Za-z0-9\s.]+?)(?=\s+en\s+tu|\s+el|\s*$|\s*,)/i)
  if (senderMatch && senderMatch[1]) {
    const cleanSender = senderMatch[1].trim()
    if (cleanSender.length > 0) {
      counterparty_name = cleanSender
    }
  }

  let counterparty_account_last_digits: string | null = null
  const targetAccMatch =
    text.match(/a\s+la\s+cuenta\s+\*?"([^"]*)"/i) || text.match(/a\s+la\s+cuenta\s+\*?(\d{3,8})/i)
  if (targetAccMatch && targetAccMatch[1]) {
    const cleanTarget = targetAccMatch[1].trim()
    if (cleanTarget.length > 0 && /^\d+$/.test(cleanTarget)) {
      counterparty_account_last_digits = cleanTarget
    }
  }

  return {
    success: true,
    data: {
      bank_name: 'Bancolombia',
      notification_type: notificationType,
      amount: parsedAmount,
      occurred_on,
      occurred_time,
      merchant,
      account_last_digits,
      card_last_digits,
      card_type,
      counterparty_name,
      counterparty_account_last_digits,
    },
  }
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
