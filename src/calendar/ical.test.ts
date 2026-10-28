/// <reference types="node" />
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { expandResources, weekRange } from '../../supabase/functions/_shared/icloud/ical'
import { appleUrl, childUrl, decryptCredentials, encryptCredentials, safeEventUrl } from '../../supabase/functions/_shared/icloud/security'

beforeEach(() => { vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { vi.unstubAllGlobals() })
const resource = (events: string) => [{ calendar_id: 'calendar', href: 'https://p01-caldav.icloud.com/a/calendar/item.ics', etag: 'v1',
  ical: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.replace(/\n/g, '\r\n')}\r\nEND:VCALENDAR` }]
const event = (body: string) => `BEGIN:VEVENT\nUID:one\n${body}\nEND:VEVENT`

describe('interpretación iCalendar real con ICAL.js', () => {
  it('conserva todo el día y su fin exclusivo sin convertirlo a UTC', async () => {
    const rows = await expandResources(resource(event('DTSTART;VALUE=DATE:20261027\nDTEND;VALUE=DATE:20261029\nSUMMARY:Viaje')), '2026-10-26')
    expect(rows).toMatchObject([{ all_day: true, start_on: '2026-10-27', end_on: '2026-10-29', starts_at: null }])
    expect(await expandResources(resource(event('DTSTART;VALUE=DATE:20261025\nDTEND;VALUE=DATE:20261026')), '2026-10-26')).toEqual([])
  })
  it('usa Bogotá para horas flotantes y convierte TZID con horario de verano', async () => {
    const floating = await expandResources(resource(event('DTSTART:20261027T090000\nDTEND:20261027T100000')), '2026-10-26')
    expect(floating[0].starts_at).toBe('2026-10-27T14:00:00Z')
    const dst = await expandResources(resource(event('DTSTART;TZID=America/New_York:20261031T090000\nDTEND;TZID=America/New_York:20261031T100000\nRRULE:FREQ=DAILY;COUNT=3')), '2026-10-26')
    expect(dst.map((row) => row.starts_at)).toEqual(['2026-10-31T13:00:00Z', '2026-11-01T14:00:00Z'])
  })
  it('expande RRULE, EXDATE, excepciones movidas y canceladas sin duplicar instancias', async () => {
    const data = resource(event('DTSTART:20261026T150000Z\nDTEND:20261026T160000Z\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE:20261027T150000Z\nSUMMARY:Serie')
      + '\n' + event('RECURRENCE-ID:20261028T150000Z\nDTSTART:20261028T180000Z\nDTEND:20261028T190000Z\nSUMMARY:Movida')
      + '\n' + event('RECURRENCE-ID:20261029T150000Z\nSTATUS:CANCELLED'))
    const rows = await expandResources(data, '2026-10-26')
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.starts_at)).toContain('2026-10-28T18:00:00.000Z')
    expect(new Set(rows.map((row) => row.occurrence_key)).size).toBe(3)
    expect(await expandResources(data, '2026-10-26')).toEqual(rows)
  })
  it('incluye una excepción desplazada desde fuera de la semana y excluye una serie cancelada', async () => {
    const data = event('DTSTART:20261001T150000Z\nDTEND:20261001T160000Z\nRRULE:FREQ=WEEKLY;COUNT=8')
      + '\n' + event('RECURRENCE-ID:20261112T150000Z\nDTSTART:20261027T150000Z\nDTEND:20261027T160000Z\nSUMMARY:Adelantada')
    expect((await expandResources(resource(data), '2026-10-26')).some((row) => row.title === 'Adelantada')).toBe(true)
    expect(await expandResources(resource(event('DTSTART:20261027T150000Z\nDTEND:20261027T160000Z\nRRULE:FREQ=DAILY;COUNT=2\nSTATUS:CANCELLED')), '2026-10-26')).toEqual([])
  })
  it('limita la ventana y no interpreta un iCalendar inválido como calendario vacío', async () => {
    expect(weekRange('2026-12-28').endOn).toBe('2027-01-04')
    expect(() => weekRange('2026-10-27')).toThrow()
    await expect(expandResources([{ ...resource('')[0], ical: '<html>Error</html>' }], '2026-10-26')).rejects.toThrow()
  })
  it('aplica UNTIL en el instante correcto para IANA y respeta VTIMEZONE embebido', async () => {
    const rows = await expandResources(resource(event('DTSTART;TZID=Pacific/Kiritimati:20261027T090000\nDTEND;TZID=Pacific/Kiritimati:20261027T100000\nRRULE:FREQ=DAILY;UNTIL=20261028T200000Z')), '2026-10-26')
    expect(rows).toHaveLength(3)
    const custom = resource('BEGIN:VTIMEZONE\nTZID:Custom/Private\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0500\nEND:STANDARD\nEND:VTIMEZONE\n' + event('DTSTART;TZID=Custom/Private:20261027T090000\nDTEND;TZID=Custom/Private:20261027T100000'))
    expect((await expandResources(custom, '2026-10-26'))[0].starts_at).toBe('2026-10-27T14:00:00.000Z')
  })
  it('respeta RANGE=THISANDFUTURE y el día implícito de un evento de todo el día', async () => {
    const shifted = resource(event('DTSTART:20261020T150000Z\nDTEND:20261020T160000Z\nRRULE:FREQ=DAILY;COUNT=25')
      + '\n' + event('RECURRENCE-ID;RANGE=THISANDFUTURE:20261105T150000Z\nDTSTART:20261027T150000Z\nDTEND:20261027T160000Z\nSUMMARY:Futuro movido'))
    expect((await expandResources(shifted, '2026-10-26')).filter((row) => row.title === 'Futuro movido')).toHaveLength(6)
    expect((await expandResources(resource(event('DTSTART;VALUE=DATE:20261027')), '2026-10-26'))[0].end_on).toBe('2026-10-28')
  })
  it('combina fechas RDATE y EXDATE sin generar una copia extra de DTSTART', async () => {
    const rows = await expandResources(resource(event('DTSTART:20261026T150000Z\nDTEND:20261026T160000Z\nRDATE:20261028T150000Z,20261029T150000Z\nEXDATE:20261026T150000Z')), '2026-10-26')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.starts_at)).toEqual(['2026-10-28T15:00:00.000Z', '2026-10-29T15:00:00.000Z'])
  })
})

describe('protección de credenciales y destinos', () => {
  it.each(['http://caldav.icloud.com/', 'https://127.0.0.1/', 'https://caldav.icloud.com.evil.test/', 'https://evil.icloud.com/', 'https://caldav.icloud.com:8443/', 'https://user:pass@caldav.icloud.com/', 'https://caldav.icloud.com/?token=x'])('rechaza %s', (url) => { expect(() => appleUrl(url)).toThrow() })
  it('permite únicamente hosts CalDAV de Apple y objetos bajo su colección', () => {
    expect(appleUrl('/a/', 'https://p123-caldav.icloud.com/')).toBe('https://p123-caldav.icloud.com/a/')
    expect(() => childUrl('/otro/item.ics', 'https://p01-caldav.icloud.com/a/')).toThrow()
    expect(safeEventUrl('javascript:alert(1)')).toBeNull()
    expect(safeEventUrl('https://user:pass@host.test/')).toBeNull()
  })
  it('cifra, autentica al propietario y detecta alteraciones del secreto', async () => {
    const key = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('base64')
    const encrypted = await encryptCredentials({ email: 'a@example.test', password: 'aaaa-bbbb-cccc-dddd' }, key, 'a')
    expect(encrypted).not.toContain('aaaa-bbbb')
    expect(await decryptCredentials(encrypted, key, 'a')).toEqual({ email: 'a@example.test', password: 'aaaa-bbbb-cccc-dddd' })
    await expect(decryptCredentials(encrypted, key, 'b')).rejects.toThrow('reconnect_required')
    await expect(decryptCredentials(encrypted.slice(0, -5), key, 'a')).rejects.toThrow()
  })
})
