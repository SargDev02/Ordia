import { supabase } from './supabase'
import type { CalendarEvent, CalendarSnapshot, CalendarWindow, IcloudCalendar, IcloudConnection } from '../types/calendar'
import type { CalendarResponse } from '../calendar/useCalendarProvider'

const messages: Record<string, string> = {
  google_configuration_pending: 'Google Calendar está pendiente de configurar en Google Cloud y en el servidor de Ordia.',
  google_unauthorized: 'Tu sesión de Ordia no está disponible. Vuelve a iniciar sesión.',
  google_reconnect_required: 'Google revocó o venció la autorización. Vuelve a conectar Google Calendar.',
  google_permission_required: 'Faltan permisos de lectura. Vuelve a conectar Google y concede los permisos del calendario.',
  google_refresh_missing: 'Google no entregó acceso renovable para esta cuenta. Reconecta y confirma el consentimiento.',
  google_sync_busy: 'Ya hay una operación de Google en curso. Espera y vuelve a intentar.',
  google_rate_limited: 'Se alcanzó el límite de intentos. Espera 15 minutos antes de reconectar Google.',
  google_calendar_changed: 'Un calendario de Google cambió o ya no es accesible. Actualiza su lista y revisa la selección.',
  google_api_disabled: 'La API de Google Calendar no está habilitada para el cliente OAuth de Ordia.',
  google_limit_reached: 'El rango supera los límites de Google configurados en Ordia. Prueba elegir menos calendarios; se conserva la copia anterior.',
  google_operation_cancelled: 'La conexión de Google cambió. No se guardaron resultados de una sincronización anterior.',
}
export function googleCalendarError(code: string | null) { return code ? messages[code] ?? 'No pudimos consultar Google. Se conserva la última copia válida; vuelve a intentar más tarde.' : '' }
function client() { if (!supabase) throw new Error('Supabase no está configurado.'); return supabase }
export async function invokeGoogleCalendar(action: string, payload: Record<string, unknown> = {}): Promise<CalendarResponse> {
  const { data, error } = await client().functions.invoke('google-calendar', { body: { action, ...payload } })
  if (error) {
    let code = ''
    try { if (error.context instanceof Response) code = (await error.context.json()).code ?? '' } catch { /* No presentar errores originales o tokens. */ }
    throw new Error(code ? googleCalendarError(code) : 'El servicio de Google Calendar no está disponible. Comprueba la conexión y la configuración del servidor.')
  }
  return data
}
export async function fetchGoogleSnapshot(userId: string, startOn: string): Promise<CalendarSnapshot> {
  const api = client(); const result = await api.from('google_connections').select('*').eq('user_id', userId).maybeSingle()
  if (result.error) throw new Error('No pudimos cargar la copia de Google Calendar.')
  const connection = result.data as IcloudConnection | null
  if (!connection || connection.status === 'disconnected') return { connection, calendars: [], window: null, events: [] }
  const [sources, window] = await Promise.all([
    api.from('google_calendars').select('*').eq('user_id', userId).eq('connection_id', connection.id).order('name'),
    api.from('google_windows').select('*').eq('user_id', userId).eq('connection_id', connection.id).eq('generation', connection.generation).eq('start_on', startOn).maybeSingle(),
  ])
  if (sources.error || window.error) throw new Error('No pudimos cargar los calendarios de Google.')
  const events: CalendarEvent[] = []
  if (window.data) for (let offset = 0; ; offset += 500) {
    const page = await api.from('google_events').select('*').eq('user_id', userId).eq('window_id', window.data.id).order('id').range(offset, offset + 499)
    if (page.error) throw new Error('No pudimos cargar los eventos de Google.')
    events.push(...page.data as CalendarEvent[]); if (page.data.length < 500) break
  }
  return { connection, calendars: sources.data as IcloudCalendar[], window: window.data as CalendarWindow | null, events }
}
export function submitGoogleAuthorization(response: CalendarResponse) {
  const expected = 'https://dedtyhomynsmvatfnshs.supabase.co/functions/v1/google-calendar/authorize'
  if (response.authorization_endpoint !== expected || !/^[A-Za-z0-9_-]{43}$/.test(response.authorization_ticket ?? '')) throw new Error('No pudimos iniciar una autorización segura de Google.')
  // Solo un ticket efímero; nunca se reciben access_token o refresh_token de Google.
  const form = document.createElement('form'); form.method = 'POST'; form.action = expected; form.hidden = true
  const input = document.createElement('input'); input.type = 'hidden'; input.name = 'ticket'; input.value = response.authorization_ticket!
  form.append(input); document.body.append(form); form.submit(); form.remove()
}
