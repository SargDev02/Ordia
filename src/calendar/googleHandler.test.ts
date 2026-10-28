import { webcrypto } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGoogleHandler } from '../../supabase/functions/_shared/google/handler'
import { GOOGLE_AUTHORIZE, GOOGLE_CALLBACK, GOOGLE_SCOPES, seal, sha256, unseal } from '../../supabase/functions/_shared/google/security'
import type { GoogleTokens } from '../../supabase/functions/_shared/google/api'

const root = GOOGLE_CALLBACK.replace('/callback', '')
const origin = 'http://localhost:5173'
const config = { clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: btoa('k'.repeat(32)) }
const ticket = 'a'.repeat(43); const browser = 'b'.repeat(43)
const post = (body: unknown, token = 'session-a') => new Request(root, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
const json = (body: unknown) => new Response(JSON.stringify(body))
function mockAdmin() {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
  const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-a' } }, error: null })
  return { rpc, getUser, client: { rpc, auth: { getUser } } as unknown as SupabaseClient }
}

describe('endpoint Google (mocks; el estado real se prueba además en PostgreSQL)', () => {
  beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.spyOn(console, 'warn').mockImplementation(() => undefined); vi.spyOn(console, 'info').mockImplementation(() => undefined) })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('autentica antes de consultar datos y usa siempre el propietario verificado', async () => {
    const admin = mockAdmin(); const fetcher = vi.fn(); const handler = createGoogleHandler(config, admin.client, fetcher)
    expect((await handler(post({ action: 'sync' }, ''))).status).toBe(401)
    admin.getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'private' } })
    expect((await handler(post({ action: 'sync' }))).status).toBe(401)
    expect(admin.rpc).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    expect((await handler(post({ action: 'disconnect', user_id: 'user-b' }))).status).toBe(200)
    expect(admin.rpc).toHaveBeenCalledWith('disconnect_google', { p_user_id: 'user-a' })
    expect((await handler(post({ action: 'write_event' }))).status).toBe(400)
  })
  it('sin configuración permite consultar estado y borrar la conexión; no simula OAuth', async () => {
    const admin = mockAdmin(); const handler = createGoogleHandler({ clientId: '', clientSecret: '', encryptionKey: '' }, admin.client)
    expect(await (await handler(post({ action: 'status' }))).json()).toEqual({ configured: false })
    expect((await handler(post({ action: 'start' }))).status).toBe(503)
    expect((await handler(post({ action: 'disconnect' }))).status).toBe(200)
  })
  it('resuelve las rutas tal como llegan del gateway hospedado, sin aceptar rutas ajenas', async () => {
    const admin = mockAdmin(); const handler = createGoogleHandler(config, admin.client)
    expect((await handler(new Request('https://edge.test/google-calendar', { method: 'POST' }))).status).toBe(401)
    expect((await handler(new Request('https://edge.test/google-calendar/authorize'))).status).toBe(400)
    expect((await handler(new Request('https://edge.test/google-calendar/callback?state=invalid'))).status).toBe(400)
    expect((await handler(new Request('https://edge.test/another-function', { method: 'POST' }))).status).toBe(404)
  })
  it('inicia una autorización con ticket efímero y verifier cifrado; no entrega tokens al navegador', async () => {
    const admin = mockAdmin(); const response = await createGoogleHandler(config, admin.client)(post({ action: 'start', user_id: 'user-b' }))
    const data = await response.json()
    expect(data.authorization_ticket).toHaveLength(43); expect(data.authorization_endpoint).toBe(GOOGLE_AUTHORIZE)
    const args = admin.rpc.mock.calls[0][1]
    expect(args.p_hash).toBe(await sha256(data.authorization_ticket)); expect(args.p_user_id).toBe('user-a')
    const secret = await unseal<{ verifier: string }>(args.p_encrypted, config.encryptionKey, 'user-a')
    expect(secret.verifier).toHaveLength(43); expect(JSON.stringify(data)).not.toContain(secret.verifier)
  })
  it('exige POST desde Ordia para iniciar navegador y enlaza el callback a una cookie segura', async () => {
    const admin = mockAdmin(); const handler = createGoogleHandler(config, admin.client)
    expect((await handler(new Request(`${GOOGLE_AUTHORIZE}?ticket=${ticket}`))).status).toBe(400)
    expect((await handler(new Request(GOOGLE_AUTHORIZE, { method: 'POST', headers: { Origin: 'https://foreign.test' } }))).status).toBe(403)
    admin.rpc.mockResolvedValueOnce({ data: { user_id: 'user-a', encrypted: await seal({ verifier: 'v'.repeat(43) }, config.encryptionKey, 'user-a') }, error: null })
    const response = await handler(new Request(GOOGLE_AUTHORIZE, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket }).toString() }))
    expect(response.status).toBe(303)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax')
    expect(new URL(response.headers.get('location')!).searchParams.get('state')).toBe(ticket)
    expect(admin.rpc).toHaveBeenCalledWith('activate_google_oauth', expect.objectContaining({ p_hash: await sha256(ticket), p_origin: origin }))
  })
  it('rechaza state inválido, vencido, reutilizado o cookie incorrecta antes de intercambiar el código', async () => {
    const admin = mockAdmin(); const fetcher = vi.fn(); const handler = createGoogleHandler(config, admin.client, fetcher)
    expect((await handler(new Request(`${GOOGLE_CALLBACK}?state=invalid&code=private`))).status).toBe(400)
    expect(admin.rpc).not.toHaveBeenCalled()
    for (const ignored of ['expired', 'reused', 'wrong-browser']) {
      void ignored
      admin.rpc.mockResolvedValueOnce({ data: null, error: { message: 'oauth_state_invalid' } })
      const response = await handler(new Request(`${GOOGLE_CALLBACK}?state=${ticket}&code=private`, { headers: { Cookie: `__Secure-ordia_google_oauth=${browser}` } }))
      expect(response.status).toBe(400); expect(await response.text()).not.toContain('private')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('consume una sola vez, cifra los tokens y vuelve a Ordia sin código ni tokens en la URL', async () => {
    const admin = mockAdmin()
    admin.rpc.mockResolvedValueOnce({ data: { user_id: 'user-a', return_origin: origin, encrypted: await seal({ verifier: 'verifier' }, config.encryptionKey, 'user-a') }, error: null })
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_SCOPES.join(' ') }))
      .mockResolvedValueOnce(json({ sub: 'independent-sub', email: 'different@example.test' }))
      .mockResolvedValueOnce(json({ kind: 'calendar#calendarList', items: [] }))
    const response = await createGoogleHandler(config, admin.client, fetcher)(new Request(`${GOOGLE_CALLBACK}?state=${ticket}&code=fixture-code`, { headers: { Cookie: `__Secure-ordia_google_oauth=${browser}` } }))
    expect(response.headers.get('location')).toBe(`${origin}/calendario?google=connected`)
    expect(admin.rpc.mock.calls[0][0]).toBe('consume_google_oauth')
    expect(admin.rpc.mock.calls[1][0]).toBe('finish_google_oauth')
    expect(JSON.stringify(admin.rpc.mock.calls)).not.toContain('fixture-refresh')
    expect(await response.text()).toBe('')
  })
  it('correlaciona un rechazo de tokens por fase e ID sin registrar credenciales, código, state, cookie o URL', async () => {
    const admin = mockAdmin()
    admin.rpc.mockResolvedValueOnce({ data: { user_id: 'user-a', return_origin: origin, encrypted: await seal({ verifier: 'private-verifier' }, config.encryptionKey, 'user-a') }, error: null })
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private-detail-including-code' }), { status: 400 }))
    const response = await createGoogleHandler(config, admin.client, fetcher)(new Request(`${GOOGLE_CALLBACK}?state=${ticket}&code=private-oauth-code`, { headers: { Cookie: `__Secure-ordia_google_oauth=${browser}` } }))
    const destination = new URL(response.headers.get('location')!)
    expect(destination.origin).toBe(origin); expect(destination.searchParams.get('google')).toBe('error')
    const id = destination.searchParams.get('google_error_id')
    expect(id).toMatch(/^[\da-f-]{36}$/)
    const record = JSON.parse(vi.mocked(console.warn).mock.calls.at(-1)![0])
    expect(record).toMatchObject({ request_id: id, phase: 'token_exchange', outcome: 'failure', upstream_status: 400, google_reason: 'invalid_grant' })
    const logs = JSON.stringify([vi.mocked(console.warn).mock.calls, vi.mocked(console.info).mock.calls])
    for (const privateValue of ['private-oauth-code', 'private-verifier', 'private-detail', ticket, browser, config.clientSecret, config.encryptionKey, 'user-a', GOOGLE_CALLBACK]) expect(logs).not.toContain(privateValue)
    expect(admin.rpc).not.toHaveBeenCalledWith('finish_google_oauth', expect.anything())
  })
  it('distingue fallos de lectura de calendarios y de almacenamiento sin publicar errores originales', async () => {
    for (const failAt of ['calendar_list', 'connection_store']) {
      const admin = mockAdmin()
      admin.rpc.mockImplementation(async (name) => name === 'consume_google_oauth'
        ? { data: { user_id: 'user-a', return_origin: 'https://ordia-seven.vercel.app', encrypted: await seal({ verifier: 'fixture-verifier' }, config.encryptionKey, 'user-a') }, error: null }
        : name === 'finish_google_oauth' ? { data: null, error: { code: '42501', message: 'private-database-detail' } } : { data: null, error: null })
      const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_SCOPES.join(' ') }))
        .mockResolvedValueOnce(json({ sub: 'private-sub', email: 'private@example.test' }))
        .mockResolvedValueOnce(failAt === 'calendar_list' ? new Response(JSON.stringify({ error: { errors: [{ reason: 'accessNotConfigured' }], message: 'private-google-detail' } }), { status: 403 }) : json({ kind: 'calendar#calendarList', items: [] }))
      const response = await createGoogleHandler(config, admin.client, fetcher)(new Request(`${GOOGLE_CALLBACK}?state=${ticket}&code=private-code`, { headers: { Cookie: `__Secure-ordia_google_oauth=${browser}` } }))
      expect(new URL(response.headers.get('location')!).origin).toBe('https://ordia-seven.vercel.app')
      const record = JSON.parse(vi.mocked(console.warn).mock.calls.at(-1)![0])
      expect(record.phase).toBe(failAt)
      if (failAt === 'calendar_list') expect(record).toMatchObject({ upstream_status: 403, google_reason: 'accessNotConfigured' })
      else expect(record.database_code).toBe('42501')
      const logs = JSON.stringify(vi.mocked(console.warn).mock.calls)
      for (const privateValue of ['private-access', 'private-refresh', 'private-sub', 'private@example.test', 'private-code', 'private-database-detail', 'private-google-detail']) expect(logs).not.toContain(privateValue)
    }
  })
  it.each([origin, 'https://ordia-seven.vercel.app'])('conserva PKCE y callback y retorna al origen autorizado %s', async (returnOrigin) => {
    const admin = mockAdmin(); let statePayload: Record<string, string> = {}
    admin.rpc.mockImplementation(async (name, args) => {
      if (name === 'create_google_oauth_state') statePayload = args
      if (name === 'activate_google_oauth' || name === 'consume_google_oauth') return { data: { user_id: statePayload.p_user_id, return_origin: statePayload.p_origin, encrypted: statePayload.p_encrypted }, error: null }
      return { data: null, error: null }
    })
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_SCOPES.join(' ') }))
      .mockResolvedValueOnce(json({ sub: 'sub' })).mockResolvedValueOnce(json({ kind: 'calendar#calendarList', items: [] }))
    const handler = createGoogleHandler(config, admin.client, fetcher)
    const started = await (await handler(new Request(root, { method: 'POST', headers: { Origin: returnOrigin, Authorization: 'Bearer session-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }))).json()
    const authorization = await handler(new Request(GOOGLE_AUTHORIZE, { method: 'POST', headers: { Origin: returnOrigin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket: started.authorization_ticket }).toString() }))
    const googleUrl = new URL(authorization.headers.get('location')!)
    const cookies = authorization.headers.get('set-cookie')!.split(';')[0]
    const callback = await handler(new Request(`${GOOGLE_CALLBACK}?state=${started.authorization_ticket}&code=fixture-code`, { headers: { Cookie: cookies } }))
    expect(callback.headers.get('location')).toBe(`${returnOrigin}/calendario?google=connected`)
    const tokenBody = new URLSearchParams(fetcher.mock.calls[0][1].body)
    expect(tokenBody.get('redirect_uri')).toBe(GOOGLE_CALLBACK)
    expect(googleUrl.searchParams.get('redirect_uri')).toBe(GOOGLE_CALLBACK)
    const { pkceChallenge } = await import('../../supabase/functions/_shared/google/security')
    expect(await pkceChallenge(tokenBody.get('code_verifier')!)).toBe(googleUrl.searchParams.get('code_challenge'))
    expect(admin.rpc.mock.calls.find((call) => call[0] === 'consume_google_oauth')![1].p_hash).toBe(await sha256(started.authorization_ticket))
  })
  it('no redirige ni intercambia códigos si el estado apunta a un origen no autorizado', async () => {
    const admin = mockAdmin(); const fetcher = vi.fn()
    admin.rpc.mockResolvedValueOnce({ data: { user_id: 'user-a', return_origin: 'https://foreign.test', encrypted: 'fixture' }, error: null })
    const response = await createGoogleHandler(config, admin.client, fetcher)(new Request(`${GOOGLE_CALLBACK}?state=${ticket}&code=fixture-code`, { headers: { Cookie: `__Secure-ordia_google_oauth=${browser}` } }))
    expect(response.status).toBe(400); expect(response.headers.get('location')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('renueva antes de consultar y no confirma un snapshot parcial si falla la segunda página', async () => {
    const tokens: GoogleTokens = { access_token: 'old', refresh_token: 'refresh', expires_at: 0, subject: 'sub', email: '', scopes: GOOGLE_SCOPES }
    const admin = mockAdmin()
    admin.rpc.mockResolvedValueOnce({ data: { token: 'lease', connection: { id: 'conn', generation: 'g', status: 'connected' }, encrypted: await seal(tokens, config.encryptionKey, 'user-a'), calendars: [{ id: 'cal', remote_id: 'remote', selected: true }], window: null }, error: null })
    const fetcher = vi.fn().mockResolvedValueOnce(json({ access_token: 'renewed', expires_in: 3600, token_type: 'Bearer' }))
      .mockResolvedValueOnce(json({ kind: 'calendar#events', items: [], nextPageToken: 'two' })).mockRejectedValueOnce(new Error('private upstream detail'))
    const response = await createGoogleHandler(config, admin.client, fetcher)(post({ action: 'sync', start_on: '2026-10-26' }))
    expect(response.status).toBe(502)
    expect(admin.rpc.mock.calls.map((call) => call[0])).toEqual(['begin_google_operation', 'store_google_tokens', 'fail_google_operation'])
    expect(admin.rpc).toHaveBeenLastCalledWith('fail_google_operation', expect.objectContaining({ p_reconnect: false }))
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer renewed')
  })
  it('desconecta y borra primero, luego revoca sin tokens en la URL ni llamadas a iCloud', async () => {
    const admin = mockAdmin(); const tokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh' }
    admin.rpc.mockResolvedValueOnce({ data: await seal(tokens, config.encryptionKey, 'user-a'), error: null })
    const fetcher = vi.fn().mockImplementation(async () => {
      expect(admin.rpc.mock.calls[0][0]).toBe('disconnect_google')
      return new Response(null, { status: 200 })
    })
    const response = await createGoogleHandler(config, admin.client, fetcher)(post({ action: 'disconnect' }))
    expect(await response.json()).toEqual({ ok: true, revocation_pending: false })
    expect(fetcher.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke')
    expect(fetcher.mock.calls[0][1].body).toContain('token=fixture-refresh')
  })
})
