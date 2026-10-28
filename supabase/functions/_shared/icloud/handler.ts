import type { SupabaseClient } from '@supabase/supabase-js'
import { CaldavClient, type CalendarResource, type Fetcher } from './caldav.ts'
import { expandResources, weekRange } from './ical.ts'
import { credentialsInput, decryptCredentials, encryptCredentials, IcloudError } from './security.ts'

interface Operation {
  token: string
  connection: { id: string | null; generation: string | null; status: string | null; error_code?: string | null } | null
  encrypted: string | null
  calendars: { id: string; href: string; selected: boolean }[]
  window: { generation: string; synced_at: string } | null
  resources: CalendarResource[] | null
}
const allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'https://ordia-seven.vercel.app'])

export function createIcloudHandler(configuration: { encryptionKey: string }, admin: SupabaseClient, fetcher: Fetcher = fetch) {
  return async (request: Request) => {
    const origin = request.headers.get('origin')
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Vary': 'Origin' }
    if (origin && allowedOrigins.has(origin)) Object.assign(headers, { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' })
    const reply = (value: unknown, status = 200) => Response.json(value, { status, headers })
    if (origin && !allowedOrigins.has(origin)) return reply({ code: 'forbidden_origin' }, 403)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    if (request.method !== 'POST') return reply({ code: 'method_not_allowed' }, 405)
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
    if (!token) return reply({ code: 'unauthorized' }, 401)
    let userId = ''; let operation: Operation | null = null
    try {
      // Verificación remota de la sesión, sin confiar en un JWT meramente decodificado ni en user_metadata.
      const { data, error } = await admin.auth.getUser(token)
      if (error || !data.user) return reply({ code: 'unauthorized' }, 401)
      userId = data.user.id
      if (Number(request.headers.get('content-length') ?? 0) > 8192) throw new IcloudError('invalid_request')
      const reader = request.body?.getReader(); const decoder = new TextDecoder(); let raw = ''; let length = 0
      if (!reader) throw new IcloudError('invalid_request')
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break
        length += chunk.value.length
        if (length > 8192) { await reader.cancel(); throw new IcloudError('invalid_request') }
        raw += decoder.decode(chunk.value, { stream: true })
      }
      raw += decoder.decode()
      let body: Record<string, unknown>
      try { body = JSON.parse(raw) } catch { throw new IcloudError('invalid_request') }
      if (!body || typeof body !== 'object' || !['status', 'connect', 'discover', 'select', 'sync', 'disconnect'].includes(String(body.action))) throw new IcloudError('invalid_request')
      if (body.action === 'status') return reply({ configured: Boolean(configuration.encryptionKey) })
      if (body.action === 'disconnect') {
        const result = await admin.rpc('disconnect_icloud', { p_user_id: userId })
        if (result.error) throw new IcloudError('server_error', 500)
        return reply({ ok: true })
      }
      if (!configuration.encryptionKey) throw new IcloudError('configuration_pending', 503)
      const startOn = typeof body.start_on === 'string' ? body.start_on : ''
      const range = weekRange(startOn)
      const credentials = body.action === 'connect' ? credentialsInput(body.email, body.password) : null
      const begin = await admin.rpc('begin_icloud_operation', { p_user_id: userId, p_kind: body.action, p_start_on: startOn })
      if (begin.error) throw new IcloudError(begin.error.message === 'rate_limited' ? 'rate_limited' : 'sync_busy', 429)
      operation = begin.data as Operation
      const generation = operation.connection?.generation ?? null
      const finish = async (action: string, payload: unknown) => {
        const result = await admin.rpc('finish_icloud_operation', { p_user_id: userId, p_token: operation!.token,
          p_generation: generation, p_action: action, p_payload: payload })
        if (result.error) throw new IcloudError(result.error.message === 'operation_cancelled' ? 'operation_cancelled' : 'server_error', 409)
      }
      if (body.action === 'connect') {
        const client = new CaldavClient(credentials!, fetcher)
        const calendars = await client.discover()
        const encrypted = await encryptCredentials(credentials!, configuration.encryptionKey, userId)
        await finish('connect', { encrypted, calendars })
        return reply({ ok: true })
      }
      if (operation.connection?.status !== 'connected' || !operation.encrypted) throw new IcloudError('reconnect_required', 409)
      if (body.action === 'select') {
        if (!Array.isArray(body.ids) || body.ids.length > 15 || body.ids.some((id) => typeof id !== 'string' || !operation!.calendars.some((calendar) => calendar.id === id))) throw new IcloudError('invalid_calendar')
        await finish('select', { ids: [...new Set(body.ids)] })
        return reply({ ok: true })
      }
      // Incluso Actualizar respeta 15 s; las aperturas automáticas respetan 60 s.
      const minAge = body.force === true ? 15000 : 60000
      if (body.action === 'sync' && !operation.connection?.error_code && operation.window?.generation === generation && Date.now() - Date.parse(operation.window.synced_at) < minAge) {
        await finish('release', {}); return reply({ ok: true, cached: true })
      }
      const stored = await decryptCredentials(operation.encrypted, configuration.encryptionKey, userId)
      const client = new CaldavClient(stored, fetcher)
      if (body.action === 'discover') {
        const calendars = await client.discover()
        await finish('discover', { calendars }); return reply({ ok: true })
      }
      const selected = operation.calendars.filter((calendar) => calendar.selected)
      if (selected.length > 15) throw new IcloudError('limit_reached', 422)
      const resources: CalendarResource[] = []
      let totalSize = 0
      for (const calendar of selected) {
        const entries = await client.query(calendar, toCaldavTime(range.start), toCaldavTime(range.end), operation.resources ?? [])
        totalSize += entries.reduce((sum, resource) => sum + resource.ical.length, 0)
        resources.push(...entries)
        if (totalSize > 8_000_000 || resources.length > 300) throw new IcloudError('limit_reached', 422)
      }
      const events = await expandResources(resources, startOn)
      // Solo este commit reemplaza la ventana. Un fallo intermedio conserva íntegra la última copia válida.
      await finish('sync', { start_on: startOn, resources, events })
      return reply({ ok: true, events: events.length })
    } catch (caught) {
      const error = caught instanceof IcloudError ? caught : new IcloudError('server_error', 500)
      if (operation && userId) {
        try { await admin.rpc('fail_icloud_operation', { p_user_id: userId, p_token: operation.token,
          p_code: error.code, p_reconnect: error.code === 'reconnect_required' }) } catch { /* La reserva expirará sin reemplazar la copia. */ }
      }
      // Nunca se devuelve ni registra la excepción original, XML, endpoint, cabeceras o credenciales.
      return reply({ code: error.code }, error.status)
    }
  }
}

function toCaldavTime(value: string) { return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') }
