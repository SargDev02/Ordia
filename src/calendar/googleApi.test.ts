import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authorizationUrl, GoogleApi, googleWeek, type GoogleTokens } from '../../supabase/functions/_shared/google/api'
import { GOOGLE_CALLBACK, GOOGLE_SCOPES, pkceChallenge, randomSecret, seal, unseal } from '../../supabase/functions/_shared/google/security'

const config = { clientId: 'fixture-client', clientSecret: 'fixture-secret', encryptionKey: btoa('x'.repeat(32)) }
const previous: GoogleTokens = { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 0, subject: 'subject-a', email: 'different-from-ordia@example.test', scopes: GOOGLE_SCOPES }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const access = { access_token: 'new-access', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_SCOPES.join(' ') }
const source = { id: 'local-calendar', remote_id: 'private@example.test' }
const timed = { id: 'instance-1', summary: 'Evento', start: { dateTime: '2026-10-27T10:00:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-10-27T11:00:00', timeZone: 'America/New_York' } }

describe('Google OAuth y API de lectura (respuestas simuladas)', () => {
  beforeEach(() => vi.stubGlobal('crypto', webcrypto))
  afterEach(() => vi.unstubAllGlobals())
  it('cifra por usuario y usa state aleatorio y PKCE S256 sin secretos en la autorización', async () => {
    const ticket = randomSecret(); const verifier = randomSecret()
    expect(ticket).toHaveLength(43); expect(ticket).not.toBe(verifier)
    const url = new URL(await authorizationUrl(config, ticket, verifier))
    expect(url.searchParams.get('redirect_uri')).toBe(GOOGLE_CALLBACK)
    expect(url.searchParams.get('state')).toBe(ticket)
    expect(url.searchParams.get('code_challenge')).toBe(await pkceChallenge(verifier))
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.href).not.toContain(config.clientSecret); expect(url.href).not.toContain(verifier)
    const encrypted = await seal(previous, config.encryptionKey, 'user-a')
    expect(encrypted).not.toContain(previous.refresh_token)
    expect(await unseal(encrypted, config.encryptionKey, 'user-a')).toEqual(previous)
    await expect(unseal(encrypted, config.encryptionKey, 'user-b')).rejects.toThrow('google_reconnect_required')
  })
  it('conserva refresh token solo para el mismo sub; no vincula por correo ni pierde el token al renovar', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(access)).mockResolvedValueOnce(json({ sub: 'subject-a', email: previous.email })).mockResolvedValueOnce(json(access))
    const api = new GoogleApi(fetcher)
    const tokens = await api.exchange(config, 'fixture-code', 'fixture-verifier', previous)
    expect(tokens.refresh_token).toBe('old-refresh')
    expect((await api.refresh(config, tokens)).refresh_token).toBe('old-refresh')
    expect(fetcher.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token')
    expect(fetcher.mock.calls[0][1].body).toContain('code_verifier=fixture-verifier')
    expect(fetcher.mock.calls[2][1].body).toContain('refresh_token=old-refresh')
    const changed = vi.fn().mockResolvedValueOnce(json(access)).mockResolvedValueOnce(json({ sub: 'subject-b', email: previous.email }))
    await expect(new GoogleApi(changed).exchange(config, 'code', 'verifier', previous)).rejects.toThrow('google_refresh_missing')
  })
  it('requiere ambos permisos de lectura y clasifica una autorización revocada sin reenviar el error', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ ...access, refresh_token: 'new-refresh', scope: 'openid email' })).mockResolvedValueOnce(json({ sub: 'subject-a' }))
    await expect(new GoogleApi(fetcher).exchange(config, 'code', 'verifier')).rejects.toThrow('google_permission_required')
    await expect(new GoogleApi(vi.fn().mockResolvedValue(json({ error: 'invalid_grant', error_description: 'private' }, 400))).refresh(config, previous)).rejects.toThrow('google_reconnect_required')
  })
  it('no confunde razones arbitrarias del proveedor con campos seguros de diagnóstico', async () => {
    const api = new GoogleApi(vi.fn().mockResolvedValue(json({ error: 'private-token-in-error', error_description: 'private-description' }, 400)))
    await expect(api.refresh(config, previous)).rejects.toMatchObject({ googleReason: 'unclassified', upstreamStatus: 400 })
  })
  it('pagina calendarios completos, conserva sus identificadores y no realiza escrituras', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ kind: 'calendar#calendarList', items: [{ id: 'a', summary: 'A', accessRole: 'reader' }], nextPageToken: 'page2' }))
      .mockResolvedValueOnce(json({ kind: 'calendar#calendarList', items: [{ id: 'b', summary: 'B', accessRole: 'owner', backgroundColor: '#123456' }] }))
    expect(await new GoogleApi(fetcher).calendars('access')).toEqual([{ remote_id: 'a', name: 'A', color: '#4277b8' }, { remote_id: 'b', name: 'B', color: '#123456' }])
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('pageToken')).toBe('page2')
    expect(fetcher.mock.calls.every((call) => !call[1].method)).toBe(true)
  })
  it('expande instancias mediante Google, descarta cancelaciones y conserva excepciones, todo el día y zonas', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ kind: 'calendar#events', items: [
      { ...timed, recurringEventId: 'series', originalStartTime: { dateTime: '2026-10-26T10:00:00-04:00' } },
      { id: 'cancelled', status: 'cancelled' },
    ], nextPageToken: 'events2' })).mockResolvedValueOnce(json({ kind: 'calendar#events', items: [
      { id: 'all-day', start: { date: '2026-10-28' }, end: { date: '2026-10-30' }, htmlLink: 'javascript:alert(1)' },
    ] }))
    const events = await new GoogleApi(fetcher).events(source, 'access', '2026-10-26')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ starts_at: '2026-10-27T14:00:00Z', ends_at: '2026-10-27T15:00:00Z', recurring_event_id: 'series', recurring_original_start: { dateTime: '2026-10-26T10:00:00-04:00' } })
    expect(events[1]).toMatchObject({ all_day: true, start_on: '2026-10-28', end_on: '2026-10-30', url: null })
    const query = new URL(fetcher.mock.calls[0][0])
    expect(query.searchParams.get('singleEvents')).toBe('true'); expect(query.searchParams.get('showDeleted')).toBe('true')
    expect(query.searchParams.get('timeMin')).toBe('2026-10-26T05:00:00Z')
    expect(query.searchParams.has('syncToken')).toBe(false)
    const repeated = await new GoogleApi(vi.fn().mockResolvedValue(json({ kind: 'calendar#events', items: [timed] }))).events(source, 'access', '2026-10-26')
    expect(repeated[0].occurrence_key).toBe(events[0].occurrence_key)
  })
  it('rechaza páginas incompletas, fallos intermedios, ciclos y fechas inválidas sin devolver un snapshot parcial', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ kind: 'calendar#events', items: [timed], nextPageToken: 'two' })).mockResolvedValueOnce(json({ error: 'private detail' }, 503))
    await expect(new GoogleApi(fetcher).events(source, 'access', '2026-10-26')).rejects.toThrow('google_unavailable')
    const cycle = vi.fn().mockImplementation(() => Promise.resolve(json({ kind: 'calendar#events', items: [], nextPageToken: 'same' })))
    await expect(new GoogleApi(cycle).events(source, 'access', '2026-10-26')).rejects.toThrow('google_incomplete_response')
    const invalid = { ...timed, start: { date: '2026-02-30' } }
    await expect(new GoogleApi(vi.fn().mockResolvedValue(json({ kind: 'calendar#events', items: [invalid] }))).events(source, 'access', '2026-10-26')).rejects.toThrow('google_incomplete_response')
    expect(googleWeek('2026-12-28').endOn).toBe('2027-01-04')
    expect(() => googleWeek('2026-10-27')).toThrow('google_invalid_request')
  })
})
