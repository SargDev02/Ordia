import { getBogotaToday } from '../finance/calculations'
import type { CalendarEvent } from '../types/calendar'
import { Temporal } from '@js-temporal/polyfill'

export function addCalendarDays(date: string, days: number) {
  return Temporal.PlainDate.from(date).add({ days }).toString()
}
export function calendarWeekStart(date: string) {
  return addCalendarDays(date, 1 - Temporal.PlainDate.from(date).dayOfWeek)
}
export function eventsOnDay(events: CalendarEvent[], date: string) {
  const dateValue = Temporal.PlainDate.from(date)
  const start = dateValue.toZonedDateTime({ timeZone: 'America/Bogota', plainTime: '00:00' }).epochMilliseconds
  const end = dateValue.add({ days: 1 }).toZonedDateTime({ timeZone: 'America/Bogota', plainTime: '00:00' }).epochMilliseconds
  return events.filter((event) => event.all_day ? event.start_on! <= date && event.end_on! > date
    : Date.parse(event.starts_at!) < end && (Date.parse(event.ends_at!) > start || Date.parse(event.starts_at!) === start))
    .sort((a, b) => Number(b.all_day) - Number(a.all_day) || (a.starts_at ?? a.start_on ?? '').localeCompare(b.starts_at ?? b.start_on ?? '') || a.id.localeCompare(b.id))
}
export function calendarDayLabel(date: string) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`))
}
export function calendarTime(instant: string) { return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' }).format(new Date(instant)) }
export function eventTimeLabel(event: CalendarEvent) {
  if (event.all_day) return event.start_on === addCalendarDays(event.end_on!, -1) ? 'Todo el día' : `Todo el día · ${event.start_on} a ${addCalendarDays(event.end_on!, -1)}`
  return `${getBogotaToday(new Date(event.starts_at!))} ${calendarTime(event.starts_at!)} — ${getBogotaToday(new Date(event.ends_at!))} ${calendarTime(event.ends_at!)}`
}
export function safeCalendarLink(value: string | null) {
  if (!value) return null
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}
