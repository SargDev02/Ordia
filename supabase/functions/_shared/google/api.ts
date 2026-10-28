import { Temporal } from '@js-temporal/polyfill'
import { GOOGLE_CALLBACK, GOOGLE_SCOPES, GoogleCalendarError, limitedText, pkceChallenge, safeGoogleLink, safeGoogleReason, sha256, type GoogleApiPhase, type GoogleApiReporter } from './security.ts'

export interface GoogleTokens { access_token: string; refresh_token: string; expires_at: number; subject: string; email: string; scopes: string[] }
export interface GoogleConfig { clientId: string; clientSecret: string; encryptionKey: string }
export interface GoogleSource { remote_id: string; name: string; color: string }
type ObjectValue = Record<string, unknown>
export function googleWeek(start: string) {
  try {
    const day = Temporal.PlainDate.from(start)
    if (day.toString() !== start || day.dayOfWeek !== 1 || day.year < 1900 || day.year > 2099) throw new Error()
    const toInstant = (date: Temporal.PlainDate) => date.toZonedDateTime({ timeZone: 'America/Bogota', plainTime: '00:00' }).toInstant().toString()
    return { start: toInstant(day), end: toInstant(day.add({ days: 7 })), startOn: start, endOn: day.add({ days: 7 }).toString() }
  } catch { throw new GoogleCalendarError('google_invalid_request') }
}
export async function authorizationUrl(config: GoogleConfig, state: string, verifier: string) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: GOOGLE_CALLBACK, response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state,
    code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256' }).toString()
  return url.href
}

export class GoogleApi {
  private fetcher: typeof fetch
  private signal: AbortSignal
  private reporter: GoogleApiReporter
  private currentPhase: GoogleApiPhase = 'token_exchange'
  constructor(fetcher: typeof fetch = fetch, reporter: GoogleApiReporter = () => undefined) { this.fetcher = fetcher; this.signal = AbortSignal.timeout(60000); this.reporter = reporter }
  private phase(phase: GoogleApiPhase) { this.currentPhase = phase; this.reporter(phase) }
  private async json(url: string, init: RequestInit): Promise<ObjectValue> {
    let response: Response
    try { response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([this.signal, AbortSignal.timeout(12000)]) }) }
    catch { throw new GoogleCalendarError('google_unavailable', 502) }
    this.reporter(this.currentPhase, response.status)
    let data: ObjectValue
    try { data = JSON.parse(await limitedText(response.body, 4_000_000)) } catch (caught) { if (caught instanceof GoogleCalendarError) throw caught; throw new GoogleCalendarError('google_incomplete_response', 502) }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GoogleCalendarError('google_incomplete_response', 502)
    if (!response.ok) {
      const reason = safeGoogleReason(data.error)
      const details = { upstreamStatus: response.status, googleReason: reason }
      if (reason === 'invalid_grant' || response.status === 401) throw new GoogleCalendarError('google_reconnect_required', 409, details)
      if (reason === 'accessNotConfigured' || reason === 'serviceDisabled') throw new GoogleCalendarError('google_api_disabled', 503, details)
      if (response.status === 429 || response.status >= 500 || /RateLimit|quota|rateLimit/i.test(reason)) throw new GoogleCalendarError('google_unavailable', 503, details)
      if (response.status === 403) throw new GoogleCalendarError('google_permission_required', 409, details)
      if (response.status === 404 || response.status === 410) throw new GoogleCalendarError('google_calendar_changed', 409, details)
      throw new GoogleCalendarError('google_request_failed', 502, details)
    }
    return data
  }
  private async token(config: GoogleConfig, parameters: Record<string, string>) {
    return this.json('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }).toString() })
  }
  async exchange(config: GoogleConfig, code: string, verifier: string, existing?: GoogleTokens) {
    this.phase('token_exchange')
    const result = await this.token(config, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: GOOGLE_CALLBACK })
    this.phase('token_validation')
    const token = accessToken(result); const expiresAt = expiration(result)
    this.phase('identity')
    const identity = await this.json('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token}` } })
    this.phase('identity_validation')
    if (typeof identity.sub !== 'string' || !identity.sub || identity.sub.length > 256) throw new GoogleCalendarError('google_reconnect_required', 409)
    this.phase('refresh_validation')
    const refresh = typeof result.refresh_token === 'string' && result.refresh_token ? result.refresh_token : existing?.subject === identity.sub ? existing.refresh_token : ''
    if (!refresh) throw new GoogleCalendarError('google_refresh_missing', 409)
    this.phase('scope_validation')
    const scopes = typeof result.scope === 'string' ? result.scope.split(' ') : []
    if (!GOOGLE_SCOPES.every((scope) => scopes.includes(scope) || (scope === 'email' && scopes.includes('https://www.googleapis.com/auth/userinfo.email')))) throw new GoogleCalendarError('google_permission_required', 409)
    return { access_token: token, refresh_token: refresh, expires_at: expiresAt, subject: identity.sub,
      email: typeof identity.email === 'string' ? identity.email.slice(0, 254) : '', scopes } satisfies GoogleTokens
  }
  async refresh(config: GoogleConfig, previous: GoogleTokens): Promise<GoogleTokens> {
    this.phase('token_refresh')
    if (!previous.refresh_token) throw new GoogleCalendarError('google_reconnect_required', 409)
    const result = await this.token(config, { grant_type: 'refresh_token', refresh_token: previous.refresh_token })
    this.phase('token_validation')
    return { ...previous, access_token: accessToken(result), refresh_token: typeof result.refresh_token === 'string' && result.refresh_token ? result.refresh_token : previous.refresh_token, expires_at: expiration(result) }
  }
  async revoke(token: string) {
    try {
      const response = await this.fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString(), signal: AbortSignal.timeout(10000) })
      await response.body?.cancel(); return response.ok
    } catch { return false }
  }
  private async pages(path: string, access: string, parameters: Record<string, string>, limit: number, kind: string) {
    const items: ObjectValue[] = []; let page = ''; const seen = new Set<string>()
    do {
      const url = new URL(`https://www.googleapis.com/calendar/v3/${path}`)
      url.search = new URLSearchParams({ ...parameters, ...(page ? { pageToken: page } : {}) }).toString()
      const data = await this.json(url.href, { headers: { Authorization: `Bearer ${access}` } })
      if (data.kind !== kind || (data.items !== undefined && !Array.isArray(data.items))) throw new GoogleCalendarError('google_incomplete_response', 502)
      items.push(...(data.items ?? []) as ObjectValue[])
      if (items.length > limit || seen.size >= 100) throw new GoogleCalendarError('google_limit_reached', 422)
      if (data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || !data.nextPageToken || data.nextPageToken.length > 4096)) throw new GoogleCalendarError('google_incomplete_response', 502)
      page = (data.nextPageToken as string) ?? ''
      if (page && seen.has(page)) throw new GoogleCalendarError('google_incomplete_response', 502)
      if (page) seen.add(page)
    } while (page)
    return items
  }
  async calendars(access: string): Promise<GoogleSource[]> {
    this.phase('calendar_list')
    const items = await this.pages('users/me/calendarList', access, { maxResults: '250', minAccessRole: 'reader', showHidden: 'true',
      fields: 'kind,nextPageToken,items(id,summary,summaryOverride,backgroundColor,accessRole,deleted)' }, 100, 'calendar#calendarList')
    const result = items.filter((item) => !item.deleted).map((item) => {
      if (typeof item.id !== 'string' || !item.id || item.id.length > 2048 || !['reader', 'writer', 'owner'].includes(String(item.accessRole))) throw new GoogleCalendarError('google_incomplete_response', 502)
      return { remote_id: item.id, name: plain(item.summaryOverride || item.summary, 200) || 'Calendario Google', color: /^#[\da-f]{6}$/i.test(String(item.backgroundColor)) ? String(item.backgroundColor) : '#4277b8' }
    })
    if (new Set(result.map((item) => item.remote_id)).size !== result.length) throw new GoogleCalendarError('google_incomplete_response', 502)
    return result
  }
  async events(calendar: { id: string; remote_id: string }, access: string, startOn: string) {
    this.phase('calendar_events')
    const range = googleWeek(startOn)
    const items = await this.pages(`calendars/${encodeURIComponent(calendar.remote_id)}/events`, access, {
      timeMin: range.start, timeMax: range.end, singleEvents: 'true', showDeleted: 'true', maxResults: '2500',
      fields: 'kind,nextPageToken,items(id,status,summary,description,location,htmlLink,start,end,originalStartTime,recurringEventId)',
    }, 4000, 'calendar#events')
    const events = new Map<string, Record<string, unknown>>()
    for (const item of items) {
      if (item.status === 'cancelled') continue
      if (typeof item.id !== 'string' || !item.id || item.id.length > 2048) throw new GoogleCalendarError('google_incomplete_response', 502)
      const start = dateValue(item.start); const end = dateValue(item.end)
      const allDay = 'date' in start
      if (allDay !== ('date' in end)) throw new GoogleCalendarError('google_incomplete_response', 502)
      const begins = allDay ? start.date! : instant(start); const finishes = allDay ? end.date! : instant(end)
      if (allDay ? finishes <= begins : Date.parse(finishes) < Date.parse(begins)) throw new GoogleCalendarError('google_incomplete_response', 502)
      if (allDay ? begins >= range.endOn || finishes <= range.startOn : Date.parse(begins) >= Date.parse(range.end) || (Date.parse(finishes) <= Date.parse(range.start) && begins !== range.start)) continue
      const occurrenceKey = await sha256(item.id)
      if (events.has(occurrenceKey)) throw new GoogleCalendarError('google_incomplete_response', 502)
      events.set(occurrenceKey, { calendar_id: calendar.id, occurrence_key: occurrenceKey, provider_event_id: item.id,
        original_start: start, original_end: end, recurring_event_id: typeof item.recurringEventId === 'string' ? item.recurringEventId : null,
        recurring_original_start: item.originalStartTime ? dateValue(item.originalStartTime) : null,
        title: plain(item.summary, 500) || 'Sin título', description: plain(item.description, 10000), location: plain(item.location, 1000), url: safeGoogleLink(item.htmlLink),
        all_day: allDay, starts_at: allDay ? null : begins, ends_at: allDay ? null : finishes, start_on: allDay ? begins : null, end_on: allDay ? finishes : null })
    }
    return [...events.values()]
  }
}
function plain(value: unknown, max: number) { return typeof value === 'string' ? value.split(String.fromCharCode(0)).join('').slice(0, max) : '' }
function accessToken(value: ObjectValue) { if (typeof value.access_token !== 'string' || !value.access_token || value.token_type !== 'Bearer') throw new GoogleCalendarError('google_incomplete_response', 502); return value.access_token }
function expiration(value: ObjectValue) { const seconds = Number(value.expires_in); if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new GoogleCalendarError('google_incomplete_response', 502); return Date.now() + seconds * 1000 }
function dateValue(value: unknown): { date?: string; dateTime?: string; timeZone?: string } {
  if (!value || typeof value !== 'object') throw new GoogleCalendarError('google_incomplete_response', 502)
  const item = value as ObjectValue
  if (typeof item.date === 'string') {
    try { if (Temporal.PlainDate.from(item.date).toString() === item.date) return { date: item.date } } catch { /* Respuesta inválida: conservar copia anterior. */ }
    throw new GoogleCalendarError('google_incomplete_response', 502)
  }
  if (typeof item.dateTime !== 'string') throw new GoogleCalendarError('google_incomplete_response', 502)
  return { dateTime: item.dateTime, ...(typeof item.timeZone === 'string' ? { timeZone: item.timeZone } : {}) }
}
function instant(value: { dateTime?: string; timeZone?: string }) {
  try { return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.dateTime!) ? Temporal.Instant.from(value.dateTime!).toString()
    : Temporal.PlainDateTime.from(value.dateTime!).toZonedDateTime(value.timeZone!).toInstant().toString() }
  catch { throw new GoogleCalendarError('google_incomplete_response', 502) }
}
