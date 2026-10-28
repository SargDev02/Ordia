export class GoogleCalendarError extends Error {
  code: string; status: number
  upstreamStatus?: number; googleReason?: string; databaseCode?: string
  constructor(code: string, status = 400, diagnostics: { upstreamStatus?: number; googleReason?: string; databaseCode?: string } = {}) {
    super(code); this.code = code; this.status = status
    this.upstreamStatus = diagnostics.upstreamStatus; this.googleReason = diagnostics.googleReason; this.databaseCode = diagnostics.databaseCode
  }
}
export type GoogleApiPhase = 'token_exchange' | 'token_refresh' | 'token_validation' | 'identity' | 'identity_validation' | 'refresh_validation' | 'scope_validation' | 'calendar_list' | 'calendar_events'
export type GoogleApiReporter = (phase: GoogleApiPhase, httpStatus?: number) => void
// Solo identificadores documentados, nunca error_description, cuerpos o mensajes originales.
export function safeGoogleReason(error: unknown) {
  const reason = typeof error === 'string' ? error : (error as { errors?: { reason?: unknown }[] } | null)?.errors?.[0]?.reason
  return typeof reason === 'string' && ['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'invalid_scope', 'access_denied',
    'accessNotConfigured', 'serviceDisabled', 'insufficientPermissions', 'forbidden', 'quotaExceeded', 'userRateLimitExceeded', 'rateLimitExceeded'].includes(reason) ? reason : 'unclassified'
}
export const GOOGLE_CALLBACK = 'https://dedtyhomynsmvatfnshs.supabase.co/functions/v1/google-calendar/callback'
export const GOOGLE_AUTHORIZE = 'https://dedtyhomynsmvatfnshs.supabase.co/functions/v1/google-calendar/authorize'
export const GOOGLE_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'https://ordia-seven.vercel.app'])
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly']
export function randomSecret() { return base64url(crypto.getRandomValues(new Uint8Array(32))) }
function base64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function pkceChallenge(verifier: string) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))) }
async function key(secret: string) {
  try {
    const bytes = Uint8Array.from(atob(secret), (char) => char.charCodeAt(0))
    if (bytes.length !== 32) throw new Error()
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } catch { throw new GoogleCalendarError('google_configuration_pending', 503) }
}
export async function seal(value: unknown, secret: string, userId: string) {
  const encryptionKey = await key(secret); const iv = crypto.getRandomValues(new Uint8Array(12))
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`google:${userId}`) }, encryptionKey, new TextEncoder().encode(JSON.stringify(value)))
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(bytes)))}`
}
export async function unseal<T>(value: string, secret: string, userId: string): Promise<T> {
  const encryptionKey = await key(secret)
  try {
    const [iv, data] = value.split('.'); const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: new TextEncoder().encode(`google:${userId}`) }, encryptionKey, bytes(data))
    return JSON.parse(new TextDecoder().decode(plain))
  } catch { throw new GoogleCalendarError('google_reconnect_required', 409) }
}
export function safeGoogleLink(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}
export async function limitedText(body: ReadableStream<Uint8Array> | null, limit: number) {
  const reader = body?.getReader(); if (!reader) throw new GoogleCalendarError('google_incomplete_response', 502)
  const decoder = new TextDecoder(); let text = ''; let length = 0
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break
    length += chunk.value.length
    if (length > limit) { await reader.cancel(); throw new GoogleCalendarError('google_limit_reached', 422) }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}
