import ICAL from 'ical.js'
import { Temporal } from '@js-temporal/polyfill'
import type { CalendarResource } from './caldav.ts'
import { hashOccurrence, IcloudError, safeEventUrl } from './security.ts'

export interface EventCopy {
  calendar_id: string; occurrence_key: string; title: string; description: string; location: string; url: string | null;
  all_day: boolean; starts_at: string | null; ends_at: string | null; start_on: string | null; end_on: string | null
}

export function weekRange(startOn: string) {
  try {
    const date = Temporal.PlainDate.from(startOn)
    if (date.toString() !== startOn || date.year < 1900 || date.year > 2099 || date.dayOfWeek !== 1) throw new Error()
    const end = date.add({ days: 7 }).toString()
    const instant = (value: string) => Temporal.PlainDate.from(value).toZonedDateTime({ timeZone: 'America/Bogota', plainTime: '00:00' }).toInstant().toString()
    return { startOn, endOn: end, start: instant(startOn), end: instant(end) }
  } catch { throw new IcloudError('invalid_range') }
}

function instant(time: ICAL.Time, event: ICAL.Event, property: string) {
  if (time.zone.tzid === 'UTC' || (time.zone as ICAL.Timezone & { component?: ICAL.Component }).component) return new Date(time.toUnixTime() * 1000).toISOString()
  const zone = event.component.getFirstProperty(property)?.getParameter('tzid')
    ?? event.component.getFirstProperty('dtstart')?.getParameter('tzid') ?? 'America/Bogota'
  try {
    return Temporal.ZonedDateTime.from({ year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second, timeZone: String(zone) }).toInstant().toString()
  } catch { throw new IcloudError('unsupported_timezone', 422) }
}

function stringProp(event: ICAL.Event, property: string, limit: number) {
  // Se conserva texto, nunca HTML ejecutable; React lo escapa al presentar.
  return String(event.component.getFirstPropertyValue(property) ?? '').split(String.fromCharCode(0)).join('').slice(0, limit)
}

export async function expandResources(resources: CalendarResource[], startOn: string) {
  const range = weekRange(startOn); const copies = new Map<string, EventCopy>(); const deadline = Date.now() + 3000
  for (const resource of resources) {
    if (Date.now() > deadline) throw new IcloudError('limit_reached', 422)
    let calendar: ICAL.Component
    try { calendar = new ICAL.Component(ICAL.parse(resource.ical)) } catch { throw new IcloudError('invalid_calendar_data', 502) }
    if (calendar.name !== 'vcalendar') throw new IcloudError('invalid_calendar_data', 502)
    const components = calendar.getAllSubcomponents('vevent')
    // ICAL.js no incluye la base IANA. Para TZID sin VTIMEZONE se adapta Temporal
    // al contrato de ICAL.Timezone, también durante RRULE/UNTIL y EXDATE.
    // Cada recurso tiene sus propias zonas: no se modifica el registro global de ICAL.js.
    for (const component of components) for (const property of component.getAllProperties()) {
      const tzid = property.getParameter('tzid')
      if (!tzid) continue
      for (const value of property.getValues()) {
        const times = value instanceof ICAL.Time ? [value] : value instanceof ICAL.Period ? [value.start, value.end].filter(Boolean) : []
        for (const time of times) {
          if (!time || time.isDate || time.zone.tzid !== 'floating') continue
          const zone = new ICAL.Timezone({ tzid: String(tzid) })
          zone.utcOffset = (local) => {
            try {
              const zoned = Temporal.ZonedDateTime.from({ timeZone: String(tzid), year: local.year, month: local.month, day: local.day, hour: local.hour, minute: local.minute, second: local.second })
              return (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - zoned.epochMilliseconds) / 1000
            } catch { throw new IcloudError('unsupported_timezone', 422) }
          }
          time.zone = zone
          zone.utcOffset(time) // Valida la zona incluso si este evento queda fuera de la ventana.
        }
      }
    }
    const masters = components.filter((component) => !component.hasProperty('recurrence-id'))
    const exceptions = components.filter((component) => component.hasProperty('recurrence-id'))
    // CANCELLED puede omitir DTSTART. ICAL.Event requiere uno al calcular endDate.
    // Se normaliza exclusivamente en memoria y se sigue descartando por STATUS.
    for (const exception of exceptions) {
      if (!exception.hasProperty('dtstart') && String(exception.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') {
        exception.addPropertyWithValue('dtstart', (exception.getFirstPropertyValue('recurrence-id') as ICAL.Time).clone())
      }
    }
    const seenExceptions = new Set<ICAL.Component>()
    async function add(event: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurrenceId: ICAL.Time | null) {
      if (stringProp(event, 'status', 30).toUpperCase() === 'CANCELLED') return
      const allDay = start.isDate
      const begins = allDay ? start.toString() : instant(start, event, 'dtstart')
      const finishes = allDay ? end.toString() : instant(end, event, 'dtend')
      if (allDay ? (begins >= range.endOn || finishes <= range.startOn) : (Date.parse(begins) >= Date.parse(range.end) || (Date.parse(finishes) <= Date.parse(range.start) && begins !== range.start))) return
      if (allDay ? finishes <= begins : Date.parse(finishes) < Date.parse(begins)) throw new IcloudError('invalid_calendar_data', 502)
      const occurrenceKey = await hashOccurrence(`${event.uid}\n${recurrenceId?.toString() ?? 'single'}`)
      copies.set(`${resource.calendar_id}:${occurrenceKey}`, { calendar_id: resource.calendar_id, occurrence_key: occurrenceKey,
        title: stringProp(event, 'summary', 500) || 'Sin título', description: stringProp(event, 'description', 10000), location: stringProp(event, 'location', 1000),
        url: safeEventUrl(event.component.getFirstPropertyValue('url')), all_day: allDay,
        starts_at: allDay ? null : begins, ends_at: allDay ? null : finishes, start_on: allDay ? begins : null, end_on: allDay ? finishes : null })
      if (copies.size > 4000) throw new IcloudError('limit_reached', 422)
    }
    for (const component of masters) {
      const event = new ICAL.Event(component, { strictExceptions: true, exceptions: exceptions.filter((exception) => exception.getFirstPropertyValue('uid') === component.getFirstPropertyValue('uid')) })
      if (!event.uid || !component.hasProperty('dtstart')) throw new IcloudError('invalid_calendar_data', 502)
      if (stringProp(event, 'status', 30).toUpperCase() === 'CANCELLED') continue
      if (!event.isRecurring()) { await add(event, event.startDate, event.endDate, null); continue }
      let backwardsDays = 0
      for (const exception of exceptions.filter((item) => item.getFirstPropertyValue('uid') === event.uid)) {
        const modified = new ICAL.Event(exception)
        if (modified.modifiesFuture()) backwardsDays = Math.max(backwardsDays, Math.ceil((modified.recurrenceId.toUnixTime() - modified.startDate.toUnixTime()) / 86400))
      }
      const stopOn = Temporal.PlainDate.from(range.endOn).add({ days: backwardsDays + 1 }).toString()
      const iterator = event.iterator(); let iterations = 0
      for (let occurrence = iterator.next(); occurrence; occurrence = iterator.next()) {
        if (++iterations > 50000 || (iterations % 100 === 0 && Date.now() > deadline)) throw new IcloudError('limit_reached', 422)
        const details = event.getOccurrenceDetails(occurrence)
        if (details.item !== event) seenExceptions.add(details.item.component)
        await add(details.item, details.startDate, details.endDate, occurrence)
        // Se recorren también excepciones desplazadas desde fuera del rango más abajo.
        if (occurrence.toString().slice(0, 10) > stopOn) break
      }
    }
    for (const component of exceptions) {
      if (seenExceptions.has(component) || String(component.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') continue
      const master = masters.find((item) => item.getFirstPropertyValue('uid') === component.getFirstPropertyValue('uid'))
      if (master && String(master.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') continue
      const event = new ICAL.Event(component)
      if (!component.hasProperty('dtstart')) throw new IcloudError('invalid_calendar_data', 502)
      await add(event, event.startDate, event.endDate, event.recurrenceId)
    }
  }
  return [...copies.values()]
}
