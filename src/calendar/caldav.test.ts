import { describe, expect, it, vi } from 'vitest'
import { CaldavClient } from '../../supabase/functions/_shared/icloud/caldav'

const credentials = { email: 'fixture@example.test', password: 'aaaa-bbbb-cccc-dddd' }
const multi = (props: string, href = '/a/calendar/item.ics') => `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`

describe('CalDAV con respuestas simuladas', () => {
  it('descubre principal, home y calendarios sin fijar el shard de la cuenta', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(multi('<d:current-user-principal><d:href>https://p42-caldav.icloud.com/principal/</d:href></d:current-user-principal>'), { status: 207 }))
      .mockResolvedValueOnce(new Response(multi('<c:calendar-home-set><d:href>/home/</d:href></c:calendar-home-set>'), { status: 207 }))
      .mockResolvedValueOnce(new Response(multi('<d:resourcetype><c:calendar/></d:resourcetype><d:displayname>Personal &amp; familia</d:displayname>', '/home/personal/'), { status: 207 }))
    expect(await new CaldavClient(credentials, fetcher).discover()).toMatchObject([{ name: 'Personal & familia', href: 'https://p42-caldav.icloud.com/home/personal/' }])
    expect(fetcher.mock.calls[1][0]).toBe('https://p42-caldav.icloud.com/principal/')
    expect(fetcher.mock.calls.every((call) => call[1].method === 'PROPFIND')).toBe(true)
  })
  it('reutiliza ETag y consulta por GET solo el recurso modificado', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(multi('<d:getetag>"v1"</d:getetag>'), { status: 207 }))
      .mockResolvedValueOnce(new Response(multi('<d:getetag>"v2"</d:getetag>'), { status: 207 }))
      .mockResolvedValueOnce(new Response('new ical', { headers: { etag: '"v2"' } }))
    const client = new CaldavClient(credentials, fetcher)
    const cached = [{ calendar_id: 'a', href: 'https://p01-caldav.icloud.com/a/calendar/item.ics', etag: '"v1"', ical: 'valid snapshot' }]
    const first = await client.query({ id: 'a', href: 'https://p01-caldav.icloud.com/a/calendar/' }, '20261026T050000Z', '20261102T050000Z', cached)
    expect(first).toEqual(cached); expect(fetcher).toHaveBeenCalledOnce()
    const second = await client.query({ id: 'a', href: 'https://p01-caldav.icloud.com/a/calendar/' }, '20261026T050000Z', '20261102T050000Z', cached)
    expect(second[0].ical).toBe('new ical')
    expect(fetcher.mock.calls[2][1].headers['If-None-Match']).toBe('"v1"')
  })
  it('rechaza redirección externa antes de enviar credenciales al destino', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secrets' } }))
    await expect(new CaldavClient(credentials, fetcher).request('https://caldav.icloud.com/', 'PROPFIND')).rejects.toThrow('invalid_server')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it.each([401, 403])('detiene credenciales rechazadas (%s) sin reintentos', async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('private body', { status }))
    await expect(new CaldavClient(credentials, fetcher).discover()).rejects.toThrow('reconnect_required')
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('falla ante XML parcial/DTD y no lo interpreta como eliminación de todos los eventos', async () => {
    for (const body of ['<d:multistatus', '<!DOCTYPE x [<!ENTITY xx "x">]><multistatus/>', '<error/>']) {
      const fetcher = vi.fn().mockResolvedValue(new Response(body, { status: 207 }))
      await expect(new CaldavClient(credentials, fetcher).query({ id: 'a', href: 'https://p01-caldav.icloud.com/a/' }, '20261026T050000Z', '20261102T050000Z', [])).rejects.toThrow('incomplete_response')
    }
  })
  it('descarga sin ETag y rechaza un inventario paginado que todavía tenga más respuestas', async () => {
    const noEtag = '<multistatus><response><href>/a/item.ics</href><propstat><prop><getetag/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>'
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(noEtag, { status: 207 })).mockResolvedValueOnce(new Response('ical without etag'))
    expect((await new CaldavClient(credentials, fetcher).query({ id: 'a', href: 'https://p01-caldav.icloud.com/a/' }, '20261026T050000Z', '20261102T050000Z', []))[0].ical).toBe('ical without etag')
    const conditional = vi.fn().mockResolvedValueOnce(new Response(noEtag, { status: 207 })).mockResolvedValueOnce(new Response(null, { status: 304 }))
    const cached = [{ calendar_id: 'a', href: 'https://p01-caldav.icloud.com/a/item.ics', etag: '"old"', ical: 'valid cached ical' }]
    expect(await new CaldavClient(credentials, conditional).query({ id: 'a', href: 'https://p01-caldav.icloud.com/a/' }, '20261026T050000Z', '20261102T050000Z', cached)).toEqual(cached)
    const paginated = vi.fn().mockResolvedValue(new Response('<multistatus/>', { status: 207, headers: { link: '<https://p01-caldav.icloud.com/a/>; rel="next"' } }))
    await expect(new CaldavClient(credentials, paginated).query({ id: 'a', href: 'https://p01-caldav.icloud.com/a/' }, '20261026T050000Z', '20261102T050000Z', [])).rejects.toThrow('incomplete_response')
  })
})
