export class IcloudError extends Error {
  code: string
  status: number
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status }
}

export function appleUrl(value: string, base = 'https://caldav.icloud.com/') {
  let url: URL
  try { url = new URL(value, base) } catch { throw new IcloudError('invalid_server', 502) }
  if (url.protocol !== 'https:' || !/^(?:caldav|p\d{2,3}-caldav)\.icloud\.com$/.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash) throw new IcloudError('invalid_server', 502)
  return url.href
}

export function childUrl(value: string, parent: string) {
  const url = new URL(appleUrl(value, parent)); const root = new URL(appleUrl(parent))
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`) || url.href === root.href) throw new IcloudError('invalid_server', 502)
  return url.href
}

export function safeEventUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}

function bytesToBase64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)) }
function base64ToBytes(value: string) { return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)) }

async function encryptionKey(secret: string) {
  try {
    const bytes = base64ToBytes(secret)
    if (bytes.length !== 32) throw new Error()
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  } catch { throw new IcloudError('configuration_pending', 503) }
}

export async function encryptCredentials(value: { email: string; password: string }, secret: string, userId: string) {
  const key = await encryptionKey(secret); const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(userId) }, key, new TextEncoder().encode(JSON.stringify(value)))
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`
}

export async function decryptCredentials(value: string, secret: string, userId: string): Promise<{ email: string; password: string }> {
  const key = await encryptionKey(secret)
  try {
    const [iv, ciphertext] = value.split('.')
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(iv), additionalData: new TextEncoder().encode(userId) }, key, base64ToBytes(ciphertext))
    return JSON.parse(new TextDecoder().decode(plain))
  } catch { throw new IcloudError('reconnect_required', 409) }
}

export function credentialsInput(email: unknown, password: unknown) {
  if (typeof email !== 'string' || !/^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(email) || email.length > 254
    || typeof password !== 'string' || !/^[a-z]{4}(?:-[a-z]{4}){3}$/i.test(password)) throw new IcloudError('invalid_credentials_format')
  return { email: email.trim(), password }
}

export async function hashOccurrence(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
