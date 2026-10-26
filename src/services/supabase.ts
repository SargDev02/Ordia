import { createClient } from '@supabase/supabase-js'

const ORDIA_PROJECT_HOST = 'dedtyhomynsmvatfnshs.supabase.co'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim()
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

function isForbiddenBrowserKey(key: string | undefined) {
  if (!key) return false
  if (key.startsWith('sb_secret_')) return true

  const payload = key.split('.')[1]
  if (!payload) return false

  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const normalized = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(normalized)) as { role?: string }
    return parsed.role === 'service_role'
  } catch {
    return false
  }
}

function isValidProjectUrl(value: string | undefined) {
  if (!value) return false
  try {
    const url = new URL(value)
    const isOrdiaCloud = url.protocol === 'https:' && url.hostname === ORDIA_PROJECT_HOST
    const isLocalSupabase = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return (isOrdiaCloud || isLocalSupabase) && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

const hasRequiredValues = Boolean(supabaseUrl && supabasePublishableKey)
const hasForbiddenKey = isForbiddenBrowserKey(supabasePublishableKey)
const hasValidUrl = isValidProjectUrl(supabaseUrl)

export const isSupabaseConfigured = hasRequiredValues && hasValidUrl && !hasForbiddenKey

export const supabaseConfigurationMessage = hasForbiddenKey
  ? 'La clave configurada no es pública. Usa únicamente la clave publicable del proyecto.'
  : hasRequiredValues && !hasValidUrl
    ? 'La URL debe corresponder al proyecto Ordia o a una instancia local de Supabase.'
  : 'Faltan las variables públicas de Supabase para conectar la autenticación.'

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabasePublishableKey!, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null
