import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createIcloudHandler } from '../../supabase/functions/_shared/icloud/handler'
import { webcrypto } from 'node:crypto'
const week = '2026-10-26'
function request(body: unknown, token = 'session-a') { return new Request('https://ordia.test/calendar', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }) }
function mockAdmin() {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
  const getUser = vi.fn().mockResolvedValue({ data: { user: { id: 'user-a' } }, error: null })
  return { rpc, getUser, client: { rpc, auth: { getUser } } as unknown as SupabaseClient }
}
describe('autenticación de la función iCloud (mocks)', () => {
  it('valida y cifra una primera conexión sin devolver sus credenciales', async () => {
    vi.stubGlobal('crypto', webcrypto)
    try {
      const admin = mockAdmin()
      admin.rpc.mockResolvedValueOnce({ data: { token: 'lease', connection: null, encrypted: null, calendars: [], window: null, resources: null }, error: null })
      const wrap = (prop: string, href = '/') => `<multistatus><response><href>${href}</href><propstat><prop>${prop}</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>`
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(wrap('<current-user-principal><href>/principal/</href></current-user-principal>'), { status: 207 }))
        .mockResolvedValueOnce(new Response(wrap('<calendar-home-set><href>/home/</href></calendar-home-set>'), { status: 207 }))
        .mockResolvedValueOnce(new Response(wrap('<resourcetype><calendar/></resourcetype><displayname>Privado</displayname>', '/home/calendar/'), { status: 207 }))
      const key = btoa(String.fromCharCode(...webcrypto.getRandomValues(new Uint8Array(32))))
      const response = await createIcloudHandler({ encryptionKey: key }, admin.client, fetcher)(request({ action: 'connect', start_on: week, email: 'fixture@example.test', password: 'aaaa-bbbb-cccc-dddd' }))
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true })
      const payload = admin.rpc.mock.calls[1][1]
      expect(payload.p_user_id).toBe('user-a'); expect(payload.p_generation).toBeNull()
      expect(payload.p_payload.encrypted).not.toContain('aaaa-bbbb')
      expect(JSON.stringify(payload)).not.toContain('fixture@example.test')
    } finally { vi.unstubAllGlobals() }
  })
  it('rechaza una sesión ausente o inválida antes de cualquier consulta o solicitud CalDAV', async () => {
    const admin = mockAdmin(); const fetcher = vi.fn()
    const handler = createIcloudHandler({ encryptionKey: 'not-used' }, admin.client, fetcher)
    expect((await handler(request({ action: 'sync' }, ''))).status).toBe(401)
    admin.getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'private diagnostic' } })
    const response = await handler(request({ action: 'connect', email: 'secret', password: 'secret' }))
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('secret')
    expect(admin.rpc).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('usa la identidad verificada, ignora un user_id enviado por el navegador y permite desconectar sin clave', async () => {
    const admin = mockAdmin(); const handler = createIcloudHandler({ encryptionKey: '' }, admin.client)
    expect((await handler(request({ action: 'disconnect', user_id: 'user-b' }))).status).toBe(200)
    expect(admin.rpc).toHaveBeenCalledWith('disconnect_icloud', { p_user_id: 'user-a' })
    expect(await (await handler(request({ action: 'status' }))).json()).toEqual({ configured: false })
  })
  it('no publica secretos ni consulta iCloud cuando falta la clave de cifrado', async () => {
    const admin = mockAdmin(); const fetcher = vi.fn()
    const response = await createIcloudHandler({ encryptionKey: '' }, admin.client, fetcher)(request({ action: 'connect', email: 'fixture@example.test', password: 'aaaa-bbbb-cccc-dddd', start_on: week }))
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ code: 'configuration_pending' })
    expect(admin.rpc).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })
  it('bloquea operaciones y formatos arbitrarios, sin reenviar datos de error', async () => {
    const admin = mockAdmin(); const handler = createIcloudHandler({ encryptionKey: 'key' }, admin.client)
    expect((await handler(request({ action: 'write_event' }))).status).toBe(400)
    expect((await handler(request({ action: 'connect', start_on: week, email: 'a@example.test', password: 'main-password' }))).status).toBe(400)
    expect(admin.rpc).not.toHaveBeenCalled()
    const origin = new Request('https://ordia.test/', { method: 'OPTIONS', headers: { origin: 'https://evil.test' } })
    expect((await handler(origin)).status).toBe(403)
  })
  it('rechaza sincronización de una conexión revocada sin reintentar Apple', async () => {
    const admin = mockAdmin(); const fetcher = vi.fn()
    admin.rpc.mockResolvedValueOnce({ data: { token: 'lease', connection: { generation: 'g', status: 'reconnect' }, calendars: [], encrypted: 'encrypted' }, error: null })
    const response = await createIcloudHandler({ encryptionKey: 'key' }, admin.client, fetcher)(request({ action: 'sync', start_on: week }))
    expect(response.status).toBe(409); expect(fetcher).not.toHaveBeenCalled()
    expect(admin.rpc).toHaveBeenLastCalledWith('fail_icloud_operation', expect.objectContaining({ p_user_id: 'user-a', p_reconnect: true }))
  })
})
