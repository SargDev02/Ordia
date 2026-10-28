import { supabase } from './supabase'
import type { CalendarEvent, CalendarSnapshot, CalendarWindow, IcloudCalendar, IcloudConnection } from '../types/calendar'

export const CALENDAR_ERRORS: Record<string, string> = {
  configuration_pending: 'La conexión de iCloud está pendiente de configuración en el servidor.',
  unauthorized: 'Tu sesión no está disponible. Vuelve a iniciar sesión en Ordia.',
  reconnect_required: 'iCloud rechazó el acceso. Reconecta con una contraseña específica vigente o revisa los permisos de tus calendarios.',
  invalid_credentials_format: 'Usa el correo de tu Apple Account y la contraseña específica de 16 letras en cuatro grupos separados por guiones.',
  rate_limited: 'Alcanzaste el límite de intentos. Espera 15 minutos antes de volver a conectar.',
  sync_busy: 'Ya hay una operación de iCloud en curso en uno de tus dispositivos. Espera y pulsa Actualizar.',
  operation_cancelled: 'La conexión cambió durante la sincronización. No se guardaron los resultados anteriores.',
  limit_reached: 'Este rango supera los límites de procesamiento. Prueba seleccionar menos calendarios. Se conserva la última copia válida.',
  unsupported_timezone: 'Un evento utiliza una zona horaria que no se pudo interpretar. Se conserva la última copia válida.',
  invalid_calendar: 'La selección de calendarios cambió. Actualiza la lista y vuelve a elegir.',
}
export function calendarError(code: string | null) { return code ? CALENDAR_ERRORS[code] ?? 'No pudimos completar la consulta a iCloud. Se conserva la última copia válida; vuelve a intentar más tarde.' : '' }
function client() { if (!supabase) throw new Error('Supabase no está configurado.'); return supabase }

export async function invokeCalendar(action: string, payload: Record<string, unknown> = {}): Promise<{ configured?: boolean }> {
  const { data, error } = await client().functions.invoke('icloud-calendar', { body: { action, ...payload } })
  if (error) {
    let code = 'unavailable'
    try { if (error.context instanceof Response) code = (await error.context.json()).code ?? code } catch { /* Sin contenido externo en mensajes. */ }
    throw new Error(code === 'unavailable' ? 'El servicio de calendario no está disponible. Comprueba la conexión y la configuración de la función de servidor.' : calendarError(code))
  }
  return data
}

export async function fetchCalendarSnapshot(userId: string, startOn: string): Promise<CalendarSnapshot> {
  const api = client()
  const connection = await api.from('icloud_connections').select('*').eq('user_id', userId).maybeSingle()
  if (connection.error) throw new Error('No pudimos cargar la conexión de iCloud. Comprueba la configuración del servidor y vuelve a intentar.')
  const conn = connection.data as IcloudConnection | null
  if (!conn || conn.status === 'disconnected') return { connection: conn, calendars: [], window: null, events: [] }
  const [calendars, window] = await Promise.all([
    api.from('icloud_calendars').select('*').eq('user_id', userId).eq('connection_id', conn.id).order('name'),
    api.from('icloud_windows').select('*').eq('user_id', userId).eq('connection_id', conn.id).eq('generation', conn.generation).eq('start_on', startOn).maybeSingle(),
  ])
  if (calendars.error || window.error) throw new Error('No pudimos cargar la última copia del calendario.')
  const events: CalendarEvent[] = []
  if (window.data) for (let offset = 0; ; offset += 500) {
    const page = await api.from('icloud_events').select('*').eq('user_id', userId).eq('window_id', window.data.id).order('id').range(offset, offset + 499)
    if (page.error) throw new Error('No pudimos cargar los eventos. Vuelve a intentar.')
    events.push(...page.data as CalendarEvent[])
    if (page.data.length < 500) break
  }
  return { connection: conn, calendars: calendars.data as IcloudCalendar[], window: window.data as CalendarWindow | null, events }
}
