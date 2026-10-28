import type { SupabaseClient } from '@supabase/supabase-js'
import { authorizationUrl, GoogleApi, googleWeek, type GoogleConfig, type GoogleTokens } from './api.ts'
import { GOOGLE_AUTHORIZE, GOOGLE_ORIGINS, GoogleCalendarError, limitedText, randomSecret, seal, sha256, unseal } from './security.ts'

interface OAuthState { user_id: string; encrypted: string; return_origin: string; generation: string | null; existing_encrypted?: string | null }
interface Operation {
  token: string; connection: { id: string; generation: string; status: string; error_code: string | null } | null;
  encrypted: string | null; calendars: { id: string; remote_id: string; selected: boolean }[];
  window: { generation: string; synced_at: string } | null
}
const cookieName = '__Secure-ordia_google_oauth'
const cookiePath = '/functions/v1/google-calendar'
const cookie = (value: string, seconds = 600) => `${cookieName}=${value}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`
const configured = (config: GoogleConfig) => Boolean(config.clientId && config.clientSecret && config.encryptionKey)
function cookieValue(request: Request) { return request.headers.get('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? '' }

export function createGoogleHandler(config: GoogleConfig, admin: SupabaseClient, fetcher: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url); const origin = request.headers.get('origin')
    const headers: Record<string, string> = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' }
    if (origin && GOOGLE_ORIGINS.has(origin)) Object.assign(headers, { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'authorization,apikey,x-client-info,content-type', 'Access-Control-Allow-Methods': 'POST,OPTIONS' })
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers })
    // El gateway hospedado elimina /functions/v1; las pruebas/local pueden conservarlo.
    const path = url.pathname.replace(/^\/functions\/v1(?=\/)/, '').replace(/\/$/, '')
    const callback = path === '/google-calendar/callback'
    const authorize = path === '/google-calendar/authorize'
    if (origin && !GOOGLE_ORIGINS.has(origin)) return reply({ code: 'google_forbidden_origin' }, 403)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    const requestId = crypto.randomUUID()
    let phase = 'request'; let upstreamStatus: number | undefined
    const api = new GoogleApi(fetcher, (next, status) => {
      phase = next
      if (status !== undefined) upstreamStatus = status
      else if (['token_exchange', 'token_refresh', 'identity', 'calendar_list', 'calendar_events'].includes(next)) upstreamStatus = undefined
    })
    let userId = ''; let operation: Operation | null = null; let stateHash = ''; let state: OAuthState | null = null
    let issued: GoogleTokens | null = null
    const rpc = async (name: string, parameters: Record<string, unknown>) => {
      const result = await admin.rpc(name, parameters)
      if (result.error) {
        const known: Record<string, [string, number]> = { oauth_state_invalid: ['google_oauth_invalid', 400], sync_busy: ['google_sync_busy', 429], rate_limited: ['google_rate_limited', 429], operation_cancelled: ['google_operation_cancelled', 409], invalid_calendar: ['google_calendar_changed', 409] }
        const error = known[result.error.message] ?? ['google_server_error', 500]
        throw new GoogleCalendarError(error[0], error[1], { databaseCode: /^[A-Z0-9]{5}$/.test(result.error.code ?? '') ? result.error.code : undefined })
      }
      return result.data
    }
    const redirect = (destination: string) => new Response(null, { status: 303, headers: { ...headers, Location: destination } })
    try {
      if (authorize) {
        phase = 'authorize_request'
        // Navegación POST desde Ordia: la cookie se establece en contexto de primera parte.
        // No se aceptan tickets desde enlaces GET o formularios de un origen ajeno.
        if (request.method !== 'POST' || !origin || !GOOGLE_ORIGINS.has(origin) || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return reply({ code: 'google_invalid_request' }, 400)
        if (!configured(config)) throw new GoogleCalendarError('google_configuration_pending', 503)
        const form = new URLSearchParams(await limitedText(request.body, 2048)); const ticket = form.get('ticket') ?? ''
        if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new GoogleCalendarError('google_oauth_invalid')
        const browser = randomSecret(); stateHash = await sha256(ticket)
        phase = 'state_activate'
        const activated = await rpc('activate_google_oauth', { p_hash: stateHash, p_origin: origin, p_browser_hash: await sha256(browser) }) as OAuthState
        phase = 'authorize_pkce_decrypt'
        const secret = await unseal<{ verifier: string }>(activated.encrypted, config.encryptionKey, activated.user_id)
        headers['Set-Cookie'] = cookie(browser)
        return redirect(await authorizationUrl(config, ticket, secret.verifier))
      }
      if (callback) {
        phase = 'callback_validate'
        if (request.method !== 'GET') return reply({ code: 'google_invalid_request' }, 400)
        if (!configured(config)) throw new GoogleCalendarError('google_configuration_pending', 503)
        const returned = url.searchParams.get('state') ?? ''; const browser = cookieValue(request)
        if (!/^[A-Za-z0-9_-]{43}$/.test(returned) || !/^[A-Za-z0-9_-]{43}$/.test(browser)
          || (url.searchParams.has('iss') && url.searchParams.get('iss') !== 'https://accounts.google.com')) throw new GoogleCalendarError('google_oauth_invalid')
        stateHash = await sha256(returned)
        phase = 'state_consume'
        state = await rpc('consume_google_oauth', { p_hash: stateHash, p_browser_hash: await sha256(browser) }) as OAuthState
        userId = state.user_id
        if (!GOOGLE_ORIGINS.has(state.return_origin)) throw new GoogleCalendarError('google_oauth_invalid')
        headers['Set-Cookie'] = cookie('', 0)
        if (url.searchParams.has('error')) {
          await rpc('discard_google_oauth', { p_hash: stateHash })
          console.info(JSON.stringify({ event: 'google_oauth', request_id: requestId, phase: 'consent', outcome: 'denied' }))
          return redirect(`${state.return_origin}/calendario?google=denied`)
        }
        phase = 'callback_code_validate'
        const code = url.searchParams.get('code') ?? ''
        if (!code || code.length > 4096) throw new GoogleCalendarError('google_oauth_invalid')
        phase = 'callback_pkce_decrypt'
        const secret = await unseal<{ verifier: string }>(state.encrypted, config.encryptionKey, userId)
        let existing: GoogleTokens | undefined
        if (state.existing_encrypted) { try { existing = await unseal<GoogleTokens>(state.existing_encrypted, config.encryptionKey, userId) } catch { /* Una autorización nueva puede reemplazar un cifrado antiguo. */ } }
        issued = await api.exchange(config, code, secret.verifier, existing)
        const calendars = await api.calendars(issued.access_token)
        phase = 'tokens_encrypt'; upstreamStatus = undefined
        const encrypted = await seal(issued, config.encryptionKey, userId)
        phase = 'connection_store'
        await rpc('finish_google_oauth', { p_hash: stateHash, p_encrypted: encrypted, p_calendars: calendars })
        console.info(JSON.stringify({ event: 'google_oauth', request_id: requestId, phase: 'complete', outcome: 'success' }))
        return redirect(`${state.return_origin}/calendario?google=connected`)
      }
      if (path !== '/google-calendar') return reply({ code: 'google_not_found' }, 404)
      if (request.method !== 'POST') return reply({ code: 'google_method_not_allowed' }, 405)
      const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
      if (!bearer) return reply({ code: 'google_unauthorized' }, 401)
      const authenticated = await admin.auth.getUser(bearer)
      if (authenticated.error || !authenticated.data.user) return reply({ code: 'google_unauthorized' }, 401)
      userId = authenticated.data.user.id
      let body: Record<string, unknown>
      try { body = JSON.parse(await limitedText(request.body, 8192)) } catch { throw new GoogleCalendarError('google_invalid_request') }
      if (!body || typeof body !== 'object') throw new GoogleCalendarError('google_invalid_request')
      if (body.action === 'status') return reply({ configured: configured(config) })
      if (body.action === 'disconnect') {
        const encrypted = await rpc('disconnect_google', { p_user_id: userId }) as string | null
        let revoked = !encrypted
        if (encrypted && config.encryptionKey) {
          try { const tokens = await unseal<GoogleTokens>(encrypted, config.encryptionKey, userId); revoked = await api.revoke(tokens.refresh_token || tokens.access_token) } catch { revoked = false }
        }
        return reply({ ok: true, revocation_pending: !revoked })
      }
      if (!configured(config)) throw new GoogleCalendarError('google_configuration_pending', 503)
      if (body.action === 'start') {
        phase = 'state_create'
        if (!origin || !GOOGLE_ORIGINS.has(origin)) throw new GoogleCalendarError('google_forbidden_origin', 403)
        const ticket = randomSecret(); const verifier = randomSecret()
        await rpc('create_google_oauth_state', { p_user_id: userId, p_hash: await sha256(ticket), p_origin: origin, p_encrypted: await seal({ verifier }, config.encryptionKey, userId) })
        return reply({ authorization_ticket: ticket, authorization_endpoint: GOOGLE_AUTHORIZE })
      }
      if (!['sync', 'select', 'discover'].includes(String(body.action))) throw new GoogleCalendarError('google_invalid_request')
      const startOn = typeof body.start_on === 'string' ? body.start_on : ''; googleWeek(startOn)
      operation = await rpc('begin_google_operation', { p_user_id: userId, p_kind: body.action, p_start_on: startOn }) as Operation
      const connection = operation.connection
      if (connection?.status !== 'connected' || !operation.encrypted) throw new GoogleCalendarError('google_reconnect_required', 409)
      const finish = async (action: string, payload: unknown) => { await rpc('finish_google_operation', { p_user_id: userId, p_token: operation!.token, p_generation: connection.generation, p_action: action, p_payload: payload }) }
      if (body.action === 'select') {
        if (!Array.isArray(body.ids) || body.ids.length > 15 || body.ids.some((id) => typeof id !== 'string' || !operation!.calendars.some((calendar) => calendar.id === id))) throw new GoogleCalendarError('google_calendar_changed', 409)
        await finish('select', { ids: [...new Set(body.ids)] }); return reply({ ok: true })
      }
      if (body.action === 'sync' && !connection.error_code && operation.window?.generation === connection.generation && Date.now() - Date.parse(operation.window.synced_at) < (body.force === true ? 15000 : 60000)) {
        await finish('release', {}); return reply({ ok: true, cached: true })
      }
      let tokens = await unseal<GoogleTokens>(operation.encrypted, config.encryptionKey, userId)
      let refreshed = false
      const renew = async () => {
        tokens = await api.refresh(config, tokens); refreshed = true
        await rpc('store_google_tokens', { p_user_id: userId, p_token: operation!.token, p_generation: connection.generation, p_encrypted: await seal(tokens, config.encryptionKey, userId) })
      }
      if (tokens.expires_at <= Date.now() + 30000) await renew()
      const query = async (): Promise<void> => {
        if (body.action === 'discover') { await finish('discover', { calendars: await api.calendars(tokens.access_token) }); return }
        const events: Record<string, unknown>[] = []
        for (const calendar of operation!.calendars.filter((item) => item.selected)) {
          events.push(...await api.events(calendar, tokens.access_token, startOn))
          if (events.length > 4000) throw new GoogleCalendarError('google_limit_reached', 422)
        }
        await finish('sync', { start_on: startOn, events })
      }
      try { await query() }
      catch (caught) {
        if (caught instanceof GoogleCalendarError && caught.code === 'google_reconnect_required' && !refreshed) { await renew(); await query() }
        else throw caught
      }
      return reply({ ok: true })
    } catch (caught) {
      const error = caught instanceof GoogleCalendarError ? caught : new GoogleCalendarError('google_server_error', 500)
      // Esquema cerrado de diagnóstico: sin objeto Error, request, parámetros o datos del usuario.
      console.warn(JSON.stringify({ event: 'google_oauth', request_id: requestId, phase, outcome: 'failure', error_code: error.code,
        http_status: error.status, upstream_status: error.upstreamStatus ?? upstreamStatus,
        google_reason: error.googleReason, database_code: error.databaseCode }))
      headers['X-Ordia-Error-Id'] = requestId
      if (state) {
        try { await admin.rpc('discard_google_oauth', { p_hash: stateHash }) } catch { /* Vence sin poder reutilizarse. */ }
        if (issued && error.code === 'google_operation_cancelled') {
          try {
            const current = await admin.from('google_connections').select('status').eq('user_id', state.user_id).maybeSingle()
            if (current.data?.status === 'disconnected') await api.revoke(issued.refresh_token || issued.access_token)
          } catch { /* La desconexión local sigue siendo efectiva si la revocación no está disponible. */ }
        }
        headers['Set-Cookie'] = cookie('', 0)
        if (GOOGLE_ORIGINS.has(state.return_origin)) return redirect(`${state.return_origin}/calendario?google=error&google_error_id=${requestId}`)
      }
      if (operation && userId) {
        try { await admin.rpc('fail_google_operation', { p_user_id: userId, p_token: operation.token, p_code: error.code,
          p_reconnect: ['google_reconnect_required', 'google_permission_required'].includes(error.code) }) } catch { /* La reserva expira sin sustituir la copia. */ }
      }
      return reply({ code: error.code, error_id: requestId, ...(callback || authorize ? { message: 'No pudimos completar la autorización. Vuelve a Ordia e inicia la conexión de Google de nuevo.' } : {}) }, error.status)
    }
  }
}
