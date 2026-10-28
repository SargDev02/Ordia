import type { CalendarProvider, CalendarSnapshot } from '../types/calendar'
export const PROVIDER_LABELS = { icloud: 'iCloud', google: 'Google' }
export function unifyCalendars(snapshots: { provider: CalendarProvider; snapshot: CalendarSnapshot }[]) {
  return snapshots.reduce((result, { provider, snapshot }) => {
    const connection = snapshot.connection
    if (!connection || connection.status === 'disconnected') return result
    const identity = (id: string) => `${provider}:${connection.id}:${id}`
    const selected = new Set(snapshot.calendars.filter((source) => source.selected).map((source) => source.id))
    result.calendars.push(...snapshot.calendars.map((source) => ({ ...source, provider, id: identity(source.id) })))
    result.events.push(...snapshot.events.filter((event) => selected.has(event.calendar_id)).map((event) => ({ ...event, provider,
      id: `${identity(event.calendar_id)}:${event.occurrence_key}`, calendar_id: identity(event.calendar_id) })))
    return result
  }, { calendars: [] as CalendarSnapshot['calendars'], events: [] as CalendarSnapshot['events'] })
}
