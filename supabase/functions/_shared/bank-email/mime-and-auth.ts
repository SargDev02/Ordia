import { parseBancolombiaNotification, type SharedParsedBankNotification } from './parser.ts'

export interface ResendEmailAuthentication {
  spf?: string | null
  dkim?: string | null
  dmarc?: string | null
}

export interface ReceivedEmailPayload {
  id: string
  to?: string[] | string | null
  from?: string | null
  subject?: string | null
  text?: string | null
  html?: string | null
  received_for?: string[] | string | null
  message_id?: string | null
  headers?: Record<string, string | string[] | undefined> | null
  authentication?: ResendEmailAuthentication | null
}

export type InboundClassificationResult =
  | {
      kind: 'gmail_confirmation'
      confirmationCode: string | null
      confirmationUrl: string | null
    }
  | {
      kind: 'bank_notification'
      parsed: SharedParsedBankNotification
      authMechanism: 'direct_dkim_dmarc' | 'gmail_arc_forward'
    }
  | {
      kind: 'ignored'
      reason:
        | 'unverified_sender'
        | 'failed_email_authentication'
        | 'unrecognized_content'
        | 'invalid_amount_or_ambiguous'
    }

const MAX_BODY_CHARS = 262_144
const SVIX_TOLERANCE_SECONDS = 300

const OFFICIAL_BANCOLOMBIA_DOMAINS = [
  'bancolombia.com.co',
  'notificacionesbancolombia.com',
  'bancolombia.com',
] as const

const GMAIL_CONFIRMATION_SENDERS = new Set([
  'forwarding-noreply@google.com',
  'mail-noreply@google.com',
])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
}

export function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  }
  return diff === 0
}

function decodeBase64(input: string): Uint8Array | null {
  try {
    const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verifica la autenticidad criptográfica de la entrega del webhook de Resend (Svix HMAC-SHA256)
 * con ventana máxima de ±300 segundos para impedir ataques de repetición.
 */
export async function verifySvixSignature(
  rawBody: string,
  headers: Headers,
  webhookSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const svixId = headers.get('svix-id')?.trim() ?? ''
  const svixTimestamp = headers.get('svix-timestamp')?.trim() ?? ''
  const svixSignature = headers.get('svix-signature')?.trim() ?? ''
  const trimmedSecret = webhookSecret.trim()

  if (!svixId || !svixTimestamp || !svixSignature || !trimmedSecret.startsWith('whsec_')) {
    return false
  }

  if (!/^\d+$/.test(svixTimestamp)) {
    return false
  }

  const timestampSeconds = Number(svixTimestamp)
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > SVIX_TOLERANCE_SECONDS) {
    return false
  }

  const rawSecretBase64 = trimmedSecret.slice('whsec_'.length)
  if (!rawSecretBase64) return false

  const secretBytes = decodeBase64(rawSecretBase64)
  if (!secretBytes || secretBytes.length === 0) return false

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const signedContent = new TextEncoder().encode(`${svixId}.${svixTimestamp}.${rawBody}`)
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, signedContent)
  const expectedBase64 = encodeBase64(new Uint8Array(signatureBuffer))

  const candidates = svixSignature
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => entry.slice(3))

  return candidates.some((candidate) => safeEqual(candidate, expectedBase64))
}

export function extractEmailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const angleMatch = trimmed.match(/<([^<>@\s]+@[^<>@\s]+)>/)
  const candidate = (angleMatch ? angleMatch[1] : trimmed).trim().toLowerCase()
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(candidate)) return null
  return candidate
}

function getHeaderValues(
  headers: Record<string, string | string[] | undefined> | null | undefined,
  targetName: string,
): string[] {
  if (!headers) return []
  const needle = targetName.toLowerCase()
  const results: string[] = []
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== needle || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) results.push(item.trim())
      }
    } else if (typeof value === 'string' && value.trim()) {
      results.push(value.trim())
    }
  }
  return results
}

function normalizeRecipientList(toField: string[] | string | null | undefined): string[] {
  if (!toField) return []
  const items = Array.isArray(toField) ? toField : toField.split(',')
  return items.flatMap((entry) => {
    const parsed = extractEmailAddress(entry)
    return parsed ? [parsed] : []
  })
}

export function getSoleFromAddress(email: ReceivedEmailPayload): string | null {
  const fromAddress = extractEmailAddress(email.from)
  if (!fromAddress) return null

  // Si existen cabeceras From en el cuerpo MIME, verificar que no haya múltiples ni contradictorias
  const rawFromHeaders = getHeaderValues(email.headers, 'from')
  if (rawFromHeaders.length > 1) {
    return null // Múltiples cabeceras From son inválidas y potencialmente maliciosas (RFC 5322 §3.6.2)
  }
  if (rawFromHeaders.length === 1) {
    const headerFrom = extractEmailAddress(rawFromHeaders[0])
    if (!headerFrom || headerFrom !== fromAddress) {
      return null // Cabecera From contradictoria con el remitente reportado
    }
  }

  return fromAddress
}

/**
 * Extrae el `alias_local_part` (`bnc_<32-hex>`) exclusivamente desde el destinatario
 * de entrega verificado del dominio entrante configurado.
 *
 * Nunca deduce el propietario del campo `From`, del correo de acceso a Ordia,
 * de cabeceras arbitrarias del remitente (como `To:` visible o `Delivered-To` inyectado),
 * del comercio ni de terminaciones de cuenta o tarjeta.
 * Si hay cero coincidencias o más de un alias distinto del dominio en la misma entrega, rechaza.
 */
export function extractVerifiedAliasLocalPart(input: {
  inboundDomain: string
  receivedFor?: string[] | string | null
  emailTo?: string[] | string | null
  webhookReceivedFor?: string[] | string | null
  webhookTo?: string[] | string | null
}): string | null {
  const domain = input.inboundDomain.trim().toLowerCase().replace(/^@/, '')
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null

  const suffix = `@${domain}`
  const matchedAliases = new Set<string>()

  const checkCandidate = (rawAddress: string | null | undefined) => {
    const email = extractEmailAddress(rawAddress)
    if (!email || !email.endsWith(suffix)) return
    const localPart = email.slice(0, -suffix.length)
    if (/^bnc_[a-f0-9]{32}$/.test(localPart)) {
      matchedAliases.add(localPart)
    }
  }

  // 1. Destinatarios de sobre SMTP autoritativos (`received_for`) reportados por Resend
  for (const addr of normalizeRecipientList(input.receivedFor)) {
    checkCandidate(addr)
  }
  for (const addr of normalizeRecipientList(input.webhookReceivedFor)) {
    checkCandidate(addr)
  }

  // 2. Si no hubo received_for, consultar destinatario de entrega `to` de Resend
  if (matchedAliases.size === 0) {
    for (const addr of normalizeRecipientList(input.emailTo)) {
      checkCandidate(addr)
    }
    for (const addr of normalizeRecipientList(input.webhookTo)) {
      checkCandidate(addr)
    }
  }

  // Exigir exactamente un alias privado inequívoco en el dominio autorizado.
  // Rechazar entregas sin alias o con múltiples alias contradictorios.
  if (matchedAliases.size !== 1) {
    return null
  }

  return [...matchedAliases][0]
}

/**
 * Convierte HTML de correo a texto plano de forma segura sin usar DOM, sin ejecutar scripts
 * ni cargar recursos remotos.
 */
export function htmlToSafePlainText(rawHtml: string | null | undefined): string {
  if (!rawHtml) return ''
  const bounded = rawHtml.slice(0, MAX_BODY_CHARS)

  const withoutDangerousBlocks = bounded
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|noscript|svg|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Conservar texto alternativo simple de logotipos (ej. <img alt="Bancolombia">) sin abrir URLs
    .replace(/<img\b[^>]*\balt=(?:"([^"]{1,80})"|'([^']{1,80})')[^>]*>/gi, (_m, a1?: string, a2?: string) => {
      const alt = (a1 ?? a2 ?? '').replace(/[<>]/g, ' ').trim()
      return alt ? ` ${alt} ` : ' '
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|section|article|header|footer|table|h[1-6])>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')

  const decoded = withoutDangerousBlocks.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,12});/g,
    (full, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const code = Number.parseInt(entity.slice(2), 16)
        return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
      }
      if (entity.startsWith('#')) {
        const code = Number.parseInt(entity.slice(1), 10)
        return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '
      }
      return NAMED_ENTITIES[entity] ?? full
    },
  )

  return decoded
    .replace(/\r\n/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim()
}

function isOfficialBancolombiaDomain(domain: string): boolean {
  const clean = domain.trim().toLowerCase()
  return OFFICIAL_BANCOLOMBIA_DOMAINS.some(
    (official) => clean === official || clean.endsWith(`.${official}`),
  )
}

function getEmailDomain(email: string | null): string | null {
  if (!email) return null
  const atIndex = email.lastIndexOf('@')
  if (atIndex < 0) return null
  return email.slice(atIndex + 1).toLowerCase()
}

function sanitizeGoogleConfirmationUrl(candidate: string): string | null {
  try {
    const cleaned = candidate.trim().replace(/[).,;>\]"']+$/, '')
    if (cleaned.length > 2048) return null
    const parsed = new URL(cleaned)
    if (parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    if (parsed.hostname !== 'mail.google.com' && parsed.hostname !== 'isolated.mail.google.com') {
      return null
    }
    if (!parsed.pathname.startsWith('/mail/')) return null
    return parsed.toString()
  } catch {
    return null
  }
}

function hasPassingGoogleTransportAuth(email: ReceivedEmailPayload): boolean {
  if (!email.authentication) return false

  const spf = email.authentication.spf?.toLowerCase() ?? ''
  const dkim = email.authentication.dkim?.toLowerCase() ?? ''
  const dmarc = email.authentication.dmarc?.toLowerCase() ?? ''

  // Rechazar si la comprobación DMARC de Google falló
  if (dmarc === 'fail') return false

  // La evidencia debe provenir de la evaluación criptográfica de Resend en el sobre/conexión
  const hasPass = spf === 'pass' || dkim === 'pass' || dmarc === 'pass'
  if (!hasPass) return false

  // Si existen cabeceras dkim-signature en el correo, verificar alineación con google.com
  const dkimHeaders = getHeaderValues(email.headers, 'dkim-signature')
  if (dkimHeaders.length > 0) {
    const hasGoogleDkim = dkimHeaders.some((header) => {
      const match = header.match(/\bd=([a-zA-Z0-9.-]+)/i)
      if (!match) return false
      const domain = match[1].toLowerCase()
      return domain === 'google.com' || domain.endsWith('.google.com')
    })
    if (!hasGoogleDkim && dkim === 'pass' && spf !== 'pass') {
      return false
    }
  }

  return true
}

function classifyGmailConfirmation(email: ReceivedEmailPayload): {
  confirmationCode: string | null
  confirmationUrl: string | null
} | null {
  const fromAddress = getSoleFromAddress(email)
  if (!fromAddress || !GMAIL_CONFIRMATION_SENDERS.has(fromAddress)) {
    return null
  }

  if (!hasPassingGoogleTransportAuth(email)) {
    return null
  }

  const plainBody = [
    email.subject ?? '',
    email.text ? email.text.slice(0, MAX_BODY_CHARS) : '',
    email.html ? htmlToSafePlainText(email.html) : '',
  ]
    .filter(Boolean)
    .join('\n')

  if (!/reenv[ií]o|forwarding|confirmaci[oó]n|confirmation/i.test(plainBody)) {
    return null
  }

  // Extraer código numérico de confirmación de Gmail (ej. "(#123456789)" o "Código de confirmación: 123456789")
  const codeMatch =
    plainBody.match(/\(#(\d{6,12})\)/) ||
    plainBody.match(/(?:c[oó]digo\s+de\s+confirmaci[oó]n|confirmation\s+code)\s*[:#-]?\s*(\d{6,12})/i)
  const confirmationCode = codeMatch ? codeMatch[1] : null

  // Cortar antes del bloque de cancelación de Gmail para no tomar por error el enlace de cancelar solicitud
  const cancelCutIndex = plainBody.search(
    /(?:cancelar\s+esta\s+verificaci[oó]n|cancel\s+this\s+verification|por\s+error,\s+haz\s+clic)/i,
  )
  const confirmationSection = cancelCutIndex >= 0 ? plainBody.slice(0, cancelCutIndex) : plainBody

  const urlMatches = confirmationSection.match(
    /https:\/\/(?:mail|isolated\.mail)\.google\.com\/mail\/[^\s<>"']+/gi,
  )
  let confirmationUrl: string | null = null
  if (urlMatches) {
    for (const rawUrl of urlMatches) {
      const safeUrl = sanitizeGoogleConfirmationUrl(rawUrl)
      if (safeUrl) {
        confirmationUrl = safeUrl
        break
      }
    }
  }

  if (!confirmationCode && !confirmationUrl) {
    return null
  }

  return { confirmationCode, confirmationUrl }
}

/**
 * Comprueba los metadatos de autenticación de correo para un aviso de Bancolombia.
 *
 * Qué se verifica:
 * 1. El remitente `From` debe ser único, no contradictorio y pertenecer a un dominio
 *    oficial de Bancolombia (`bancolombia.com.co`, `notificacionesbancolombia.com`, `bancolombia.com`).
 *    Se rechazan múltiples cabeceras From o discrepancias entre el sobre y las cabeceras MIME.
 * 2. La autenticación debe ser verificada criptográficamente por el servidor receptor de Resend
 *    (`email.authentication.dkim = 'pass'` o `email.authentication.dmarc = 'pass'`), con `dmarc != 'fail'`.
 *    NUNCA se confía en textos o cabeceras arbitrarias escritas por el remitente
 *    (ej. "Authentication-Results" o "ARC-Authentication-Results" inyectados en el cuerpo).
 * 3. Si existen cabeceras `DKIM-Signature`, al menos una debe corresponder al dominio oficial de Bancolombia
 *    para impedir que un atacante firme con una clave de otro dominio (ej. `d=attacker.com`).
 */
function verifyBancolombiaSenderAuth(
  email: ReceivedEmailPayload,
): 'direct_dkim_dmarc' | null {
  const fromAddress = getSoleFromAddress(email)
  if (!fromAddress) {
    return null
  }

  const fromDomain = getEmailDomain(fromAddress)
  if (!fromDomain || !isOfficialBancolombiaDomain(fromDomain)) {
    return null
  }

  if (!email.authentication) {
    return null
  }

  const dkim = email.authentication.dkim?.toLowerCase() ?? ''
  const dmarc = email.authentication.dmarc?.toLowerCase() ?? ''

  // Rechazar explícitamente si DMARC falló
  if (dmarc === 'fail') {
    return null
  }

  // Resend debe certificar que DKIM o DMARC pasó la validación criptográfica en su servidor
  const hasValidAuth = dkim === 'pass' || dmarc === 'pass'
  if (!hasValidAuth) {
    return null
  }

  // Si existen firmas DKIM en cabeceras, al menos una debe pertenecer a un dominio oficial de Bancolombia
  const dkimHeaders = getHeaderValues(email.headers, 'dkim-signature')
  if (dkimHeaders.length > 0) {
    const hasBancolombiaDkim = dkimHeaders.some((header) => {
      const match = header.match(/\bd=([a-zA-Z0-9.-]+)/i)
      if (!match) return false
      return isOfficialBancolombiaDomain(match[1])
    })
    if (!hasBancolombiaDkim && dmarc !== 'pass') {
      return null
    }
  }

  return 'direct_dkim_dmarc'
}

/**
 * Limpia encabezados de reenvío añadidos por Gmail y pies legales estáticos del correo
 * bancario sin eliminar importes presentes dentro del texto del aviso.
 */
export function cleanForwardedBankBody(rawBody: string, subject?: string | null): string {
  let cleaned = rawBody.slice(0, MAX_BODY_CHARS).replace(/\r\n/g, '\n').trim()

  // Quitar cabecera estándar de mensaje reenviado de Gmail si estuviera presente
  cleaned = cleaned.replace(
    /^-{5,}\s*(?:Forwarded message|Mensaje reenviado)\s*-{5,}\s*\n(?:(?:De|From|Date|Fecha|Subject|Asunto|To|Para|Cc)\s*:[^\n]*\n)+\s*/im,
    '',
  )

  // Filtrar líneas de pie legal/seguridad informativo que rodean al aviso en correos HTML
  const filteredLines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false
      if (
        /^(?:bancolombia\s+nunca\b|nunca\s+te\s+solicitaremos|por\s+tu\s+seguridad\b|si\s+tienes\s+dudas\b|sucursal\s+telef[oó]nica\b|l[ií]nea\s+de\s+atenci[oó]n\b|este\s+es\s+un\s+mensaje\s+autom[aá]tico\b|aviso\s+legal\b|correosospechoso@bancolombia)/i.test(
          line,
        )
      ) {
        return false
      }
      return true
    })

  let result = filteredLines.join('\n').trim()

  // Si el correo HTML tenía "Bancolombia" en el asunto/encabezado pero no repetido en el párrafo
  // (y el asunto no contiene signos "$"), anteponer el asunto para conservar el contexto sin alterar importes.
  if (
    result &&
    !/bancolombia/i.test(result) &&
    subject &&
    /bancolombia/i.test(subject) &&
    !subject.includes('$')
  ) {
    result = `${subject.trim()}: ${result}`
  }

  return result
}

export function classifyInboundEmail(email: ReceivedEmailPayload): InboundClassificationResult {
  // 1. Comprobar primero si es el correo oficial de confirmación de reenvío de Gmail
  const gmailConfirmation = classifyGmailConfirmation(email)
  if (gmailConfirmation) {
    return {
      kind: 'gmail_confirmation',
      confirmationCode: gmailConfirmation.confirmationCode,
      confirmationUrl: gmailConfirmation.confirmationUrl,
    }
  }

  // 2. Comprobar remitente oficial de Bancolombia + autenticación de transporte
  const fromAddress = getSoleFromAddress(email)
  const fromDomain = getEmailDomain(fromAddress)
  if (!fromDomain || !isOfficialBancolombiaDomain(fromDomain)) {
    return { kind: 'ignored', reason: 'unverified_sender' }
  }

  const authMechanism = verifyBancolombiaSenderAuth(email)
  if (!authMechanism) {
    return { kind: 'ignored', reason: 'failed_email_authentication' }
  }

  // 3. Extraer texto seguro desde texto plano y/o HTML y aplicar el parser exacto de Bancolombia
  const candidates: string[] = []
  if (email.text && email.text.trim()) {
    candidates.push(cleanForwardedBankBody(email.text, email.subject))
  }
  if (email.html && email.html.trim()) {
    const safeHtmlText = htmlToSafePlainText(email.html)
    if (safeHtmlText) {
      candidates.push(cleanForwardedBankBody(safeHtmlText, email.subject))
    }
  }

  if (candidates.length === 0) {
    return { kind: 'ignored', reason: 'unrecognized_content' }
  }

  let sawAmountError = false
  for (const candidate of candidates) {
    const parsed = parseBancolombiaNotification(candidate)
    if (parsed.success) {
      return {
        kind: 'bank_notification',
        parsed: parsed.data,
        authMechanism,
      }
    }
    if (/importe|centavos|separadores|varios importes/i.test(parsed.error)) {
      sawAmountError = true
    }
  }

  return {
    kind: 'ignored',
    reason: sawAmountError ? 'invalid_amount_or_ambiguous' : 'unrecognized_content',
  }
}
