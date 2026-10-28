import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { appleUrl, childUrl, IcloudError } from './security.ts'

export interface RemoteCalendar { href: string; name: string; color: string }
export interface CalendarResource { calendar_id: string; href: string; etag: string | null; ical: string }
export type Fetcher = typeof fetch
type XmlObject = Record<string, unknown>
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: true,
  processEntities: { maxTotalExpansions: 10000, maxExpandedLength: 2_000_000 } })
const list = (value: unknown): XmlObject[] => !value ? [] : Array.isArray(value) ? value as XmlObject[] : [value as XmlObject]
const text = (value: unknown): string => typeof value === 'string' ? value : value && typeof value === 'object' ? String((value as XmlObject)['#text'] ?? '') : ''

export class CaldavClient {
  private authorization: string
  private signal: AbortSignal
  private fetcher: Fetcher
  constructor(credentials: { email: string; password: string }, fetcher: Fetcher = fetch) {
    this.fetcher = fetcher
    this.authorization = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${credentials.email}:${credentials.password}`)))}`
    this.signal = AbortSignal.timeout(45000)
  }

  // Única puerta de salida: no existen métodos de escritura y cada redirección se valida antes de enviar Authorization.
  async request(url: string, method: 'PROPFIND' | 'REPORT' | 'GET', body?: string, extra: Record<string, string> = {}) {
    let destination = appleUrl(url)
    for (let redirects = 0; redirects <= 4; redirects++) {
      let response: Response
      try {
        response = await this.fetcher(destination, { method, body, redirect: 'manual',
          headers: { Authorization: this.authorization, 'Content-Type': 'application/xml; charset=utf-8', ...extra },
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(12000)]) })
      } catch { throw new IcloudError('icloud_unavailable', 502) }
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel()
        if (!location) throw new IcloudError('invalid_server', 502)
        destination = appleUrl(location, destination); continue
      }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new IcloudError('reconnect_required', 409) }
      if (![200, 207, 304].includes(response.status)) { await response.body?.cancel(); throw new IcloudError('incomplete_response', 502) }
      if (/rel\s*=\s*["']?[^;>]*\bnext\b/i.test(response.headers.get('link') ?? '')) {
        await response.body?.cancel(); throw new IcloudError('incomplete_response', 502)
      }
      if (response.status === 304) return { status: 304, body: '', url: destination, etag: response.headers.get('etag') }
      const reader = response.body?.getReader(); let length = 0; const chunks: Uint8Array[] = []
      try {
        if (!reader) throw new Error()
        while (true) {
          const next = await reader.read(); if (next.done) break
          length += next.value.length
          if (length > 2_000_000) { await reader.cancel(); throw new Error() }
          chunks.push(next.value)
        }
      } catch { throw new IcloudError('incomplete_response', 502) }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      return { status: response.status, body: new TextDecoder().decode(bytes), url: destination, etag: response.headers.get('etag') }
    }
    throw new IcloudError('invalid_server', 502)
  }

  async discover(): Promise<RemoteCalendar[]> {
    const initial = await this.request('https://caldav.icloud.com/', 'PROPFIND', propfind('<d:current-user-principal/>'), { Depth: '0' })
    const principalProps = successfulProps(multistatus(initial.body)[0])
    const principal = appleUrl(text((principalProps['current-user-principal'] as XmlObject)?.href), initial.url)
    if (!(principalProps['current-user-principal'] as XmlObject)?.href) throw new IcloudError('incomplete_response', 502)
    const principalResponse = await this.request(principal, 'PROPFIND', propfind('<c:calendar-home-set/>'), { Depth: '0' })
    const homeProp = successfulProps(multistatus(principalResponse.body)[0])['calendar-home-set'] as XmlObject
    if (!homeProp?.href) throw new IcloudError('incomplete_response', 502)
    const home = appleUrl(text(homeProp.href), principalResponse.url)
    const collections = await this.request(home, 'PROPFIND', propfind('<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/>'), { Depth: '1' })
    const calendars: RemoteCalendar[] = []
    for (const response of multistatus(collections.body)) {
      const props = successfulProps(response)
      if (!Object.hasOwn((props.resourcetype as XmlObject) ?? {}, 'calendar')) continue
      const components = props['supported-calendar-component-set'] as XmlObject | undefined
      if (components && !list(components.comp).some((component) => component['@_name'] === 'VEVENT')) continue
      const href = childUrl(text(response.href), collections.url)
      const color = text(props['calendar-color']).slice(0, 7)
      calendars.push({ href, name: (text(props.displayname) || 'Calendario iCloud').slice(0, 200), color: /^#[\da-f]{6}$/i.test(color) ? color : '#4f8068' })
    }
    if (calendars.length > 100 || new Set(calendars.map((calendar) => calendar.href)).size !== calendars.length) throw new IcloudError('incomplete_response', 502)
    return calendars
  }

  async query(calendar: { id: string; href: string }, start: string, end: string, previous: CalendarResource[]) {
    const range = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}" end="${end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`
    const report = await this.request(calendar.href, 'REPORT', range, { Depth: '1' })
    if (report.status !== 207) throw new IcloudError('incomplete_response', 502)
    const resources: CalendarResource[] = []; const responses = multistatus(report.body)
    if (responses.length > 300) throw new IcloudError('limit_reached', 422)
    for (const row of responses) {
      const props = successfulProps(row, true)
      const href = childUrl(text(row.href), report.url)
      const etag = text(props.getetag) || null
      if (etag && (etag.length > 1024 || /[\r\n]/.test(etag))) throw new IcloudError('incomplete_response', 502)
      const cached = previous.find((resource) => resource.calendar_id === calendar.id && resource.href === href)
      if (etag && cached?.etag === etag) { resources.push(cached); continue }
      const object = await this.request(href, 'GET', undefined, cached?.etag ? { 'If-None-Match': cached.etag } : {})
      if (object.status === 304 && (!cached?.etag || (etag && etag !== cached.etag))) throw new IcloudError('incomplete_response', 502)
      resources.push({ calendar_id: calendar.id, href, etag: object.status === 304 ? cached!.etag : object.etag ?? etag, ical: object.status === 304 ? cached!.ical : object.body })
    }
    if (new Set(resources.map((resource) => resource.href)).size !== resources.length) throw new IcloudError('incomplete_response', 502)
    return resources
  }
}

function propfind(properties: string) { return `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop>${properties}</d:prop></d:propfind>` }

function multistatus(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new IcloudError('incomplete_response', 502)
  let parsed: XmlObject
  try { parsed = parser.parse(xml) as XmlObject } catch { throw new IcloudError('incomplete_response', 502) }
  if (!Object.hasOwn(parsed, 'multistatus')) throw new IcloudError('incomplete_response', 502)
  const root = parsed.multistatus as XmlObject
  if (root?.error || root?.['number-of-matches-within-limits']) throw new IcloudError('incomplete_response', 502)
  return list(root?.response)
}

function successfulProps(response: XmlObject | undefined, allowMissingProperty = false) {
  if (!response || (response.status && !/\s200(?:\s|$)/.test(text(response.status)))) throw new IcloudError('incomplete_response', 502)
  const props: XmlObject = {}; let success = false
  for (const propstat of list(response.propstat)) {
    if (/\s200(?:\s|$)/.test(text(propstat.status))) { Object.assign(props, propstat.prop); success = true }
    else if (!/\s404(?:\s|$)/.test(text(propstat.status))) throw new IcloudError('incomplete_response', 502)
  }
  if (!success && !(allowMissingProperty && list(response.propstat).length > 0)) throw new IcloudError('incomplete_response', 502)
  return props
}
