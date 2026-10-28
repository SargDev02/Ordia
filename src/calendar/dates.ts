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
  if (event.all_day) {
    const endOn = event.end_on && event.end_on > (event.start_on ?? '') ? event.end_on : addCalendarDays(event.start_on ?? '', 1)
    return event.start_on === addCalendarDays(endOn, -1) ? 'Todo el día' : `Todo el día · ${event.start_on} a ${addCalendarDays(endOn, -1)}`
  }
  if (!event.starts_at) return ''
  const hasValidEnd = event.ends_at && !Number.isNaN(Date.parse(event.ends_at)) && Date.parse(event.ends_at) >= Date.parse(event.starts_at)
  if (!hasValidEnd) {
    return `${getBogotaToday(new Date(event.starts_at))} ${calendarTime(event.starts_at)}`
  }
  return `${getBogotaToday(new Date(event.starts_at))} ${calendarTime(event.starts_at)} — ${getBogotaToday(new Date(event.ends_at!))} ${calendarTime(event.ends_at!)}`
}
export function safeCalendarLink(value: string | null) {
  if (!value) return null
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null }
}

/**
 * Regla explícita y documentada para eventos sin fin válido (sin inventar duraciones):
 * 1. Eventos con horario (`all_day: false`):
 *    Si `ends_at` falta, es inválido (no parseable) o es anterior a `starts_at`, su hora de fin
 *    efectiva es igual a su hora de inicio (`ends_at = starts_at`). Modela un evento puntual
 *    de duración cero. Antes de su inicio se muestra como próximo; al alcanzar o superar dicho
 *    instante (`now >= starts_at`), su fin efectivo ya se cumplió (`ends_at <= now`), por lo que
 *    se considera finalizado y se oculta del resumen. Nunca pasa por estado "En curso".
 * 2. Eventos de todo el día (`all_day: true`):
 *    Si `end_on` falta, es inválido o no es posterior a `start_on`, su fecha final exclusiva
 *    se define como el día calendario siguiente (`addCalendarDays(start_on, 1)`), representándolo
 *    como un evento del día `start_on` sin inventar una duración extendida.
 */
export interface EventEffectiveRange {
  isValid: boolean
  allDay: boolean
  startMs: number
  endMs: number
  startOn?: string
  endOn?: string
}

export function getEventEffectiveRange(event: CalendarEvent): EventEffectiveRange {
  if (event.all_day) {
    const startOn = event.start_on
    if (!startOn || !/^\d{4}-\d{2}-\d{2}$/.test(startOn)) {
      return { isValid: false, allDay: true, startMs: 0, endMs: 0 }
    }
    let endOn = event.end_on
    if (!endOn || !/^\d{4}-\d{2}-\d{2}$/.test(endOn) || endOn <= startOn) {
      endOn = addCalendarDays(startOn, 1)
    }
    return { isValid: true, allDay: true, startMs: 0, endMs: 0, startOn, endOn }
  }

  const startMs = event.starts_at ? Date.parse(event.starts_at) : NaN
  if (Number.isNaN(startMs)) {
    return { isValid: false, allDay: false, startMs: 0, endMs: 0 }
  }

  const rawEndMs = event.ends_at ? Date.parse(event.ends_at) : NaN
  const endMs = Number.isNaN(rawEndMs) || rawEndMs < startMs ? startMs : rawEndMs

  return { isValid: true, allDay: false, startMs, endMs }
}

export function isEventOnBogotaDay(event: CalendarEvent, date: string): boolean {
  const range = getEventEffectiveRange(event)
  if (!range.isValid) return false

  if (range.allDay) {
    return range.startOn! <= date && range.endOn! > date
  }

  const dateValue = Temporal.PlainDate.from(date)
  const dayStart = dateValue.toZonedDateTime({ timeZone: 'America/Bogota', plainTime: '00:00' }).epochMilliseconds
  const dayEnd = dateValue.add({ days: 1 }).toZonedDateTime({ timeZone: 'America/Bogota', plainTime: '00:00' }).epochMilliseconds

  if (range.startMs === range.endMs) {
    return range.startMs >= dayStart && range.startMs < dayEnd
  }

  return range.startMs < dayEnd && range.endMs > dayStart
}

export type TodaySummaryStatus = 'ended' | 'ongoing' | 'upcoming' | 'all_day'

export function getSummaryEventStatus(event: CalendarEvent, now: Date, todayDate: string): TodaySummaryStatus | null {
  if (!isEventOnBogotaDay(event, todayDate)) return null

  const range = getEventEffectiveRange(event)
  if (!range.isValid) return null

  if (range.allDay) {
    return 'all_day'
  }

  const nowMs = now.getTime()
  // Regla: oculta del resumen los eventos cuya hora de finalización sea menor o igual a la hora actual.
  if (range.endMs <= nowMs) {
    return 'ended'
  }

  // Regla: en curso si inició antes o exactamente a la hora actual y no ha terminado.
  if (range.startMs <= nowMs) {
    return 'ongoing'
  }

  // Todavía no ha comenzado
  return 'upcoming'
}

export interface TodaySummaryEvents {
  ongoing: CalendarEvent[]
  allDay: CalendarEvent[]
  upcoming: CalendarEvent[]
  allVisible: CalendarEvent[]
  totalEligibleCount: number
}

export function getTodaySummaryEvents(
  events: CalendarEvent[],
  now: Date,
  todayDate = getBogotaToday(now),
  limit = 5,
): TodaySummaryEvents {
  const ongoing: CalendarEvent[] = []
  const allDay: CalendarEvent[] = []
  const upcoming: CalendarEvent[] = []

  for (const event of events) {
    const status = getSummaryEventStatus(event, now, todayDate)
    if (status === 'ongoing') ongoing.push(event)
    else if (status === 'all_day') allDay.push(event)
    else if (status === 'upcoming') upcoming.push(event)
  }

  // Ordenar eventos en curso por inicio, luego id
  ongoing.sort((a, b) => (a.starts_at ?? '').localeCompare(b.starts_at ?? '') || a.id.localeCompare(b.id))
  // Ordenar eventos de todo el día por start_on, luego título o id
  allDay.sort((a, b) => (a.start_on ?? '').localeCompare(b.start_on ?? '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  // Ordenar próximos por inicio, luego id
  upcoming.sort((a, b) => (a.starts_at ?? '').localeCompare(b.starts_at ?? '') || a.id.localeCompare(b.id))

  // El límite no debe ocultar eventos en curso si hay más del límite simultáneos.
  // Se conservan todos los que están en curso y se limita únicamente el resto (todo el día y próximos).
  const nonOngoing = [...allDay, ...upcoming]
  const remainingSlots = Math.max(0, limit - ongoing.length)
  const limitedNonOngoing = nonOngoing.slice(0, remainingSlots)

  const allVisible = [...ongoing, ...limitedNonOngoing]
  const totalEligibleCount = ongoing.length + nonOngoing.length

  const visibleAllDay = limitedNonOngoing.filter((e) => allDay.includes(e))
  const visibleUpcoming = limitedNonOngoing.filter((e) => upcoming.includes(e))

  return {
    ongoing,
    allDay: visibleAllDay,
    upcoming: visibleUpcoming,
    allVisible,
    totalEligibleCount,
  }
}
