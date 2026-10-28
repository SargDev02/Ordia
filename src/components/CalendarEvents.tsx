import { useState } from 'react'
import type { CalendarEvent, IcloudCalendar } from '../types/calendar'
import { eventTimeLabel, safeCalendarLink } from '../calendar/dates'
import { FormDialog } from './FormDialog'
import { PROVIDER_LABELS } from '../calendar/unified'

export function CalendarEvents({
  events,
  calendars,
  ongoingIds,
  showAllDayGroup = false,
}: {
  events: CalendarEvent[]
  calendars: IcloudCalendar[]
  ongoingIds?: ReadonlySet<string>
  showAllDayGroup?: boolean
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = events.find((event) => event.id === selectedId) ?? null
  const calendarName = (id: string) => {
    const source = calendars.find((calendar) => calendar.id === id)
    return `${PROVIDER_LABELS[source?.provider ?? 'icloud']} · ${source?.name ?? 'Calendario'}`
  }
  const color = (id: string) => {
    const value = calendars.find((calendar) => calendar.id === id)?.color
    return /^#[a-f0-9]{6}$/i.test(value ?? '') ? value : '#4f8068'
  }
  const link = safeCalendarLink(selected?.url ?? null)

  const renderItem = (event: CalendarEvent) => {
    const isOngoing = ongoingIds?.has(event.id)
    return (
      <li key={event.id}>
        <button
          className="flex w-full min-w-0 items-start gap-3 py-4 text-left"
          onClick={() => setSelectedId(event.id)}
          type="button"
        >
          <span
            className="mt-1.5 size-3 shrink-0 rounded-full"
            style={{ backgroundColor: color(event.calendar_id) }}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="break-words font-semibold text-[#264a3c]">{event.title}</span>
              {isOngoing && (
                <span className="rounded-full bg-[#dcefe1] px-2 py-0.5 text-[11px] font-semibold text-[#1e5838]">
                  En curso
                </span>
              )}
            </span>
            <span className="mt-1 block text-xs leading-5 text-[#66796f]">
              {eventTimeLabel(event)}{event.all_day ? '' : ' · Bogotá'}
            </span>
            <span className="mt-1 block break-words text-xs text-[#718279]">
              {calendarName(event.calendar_id)}{event.location ? ` · ${event.location}` : ''}
            </span>
          </span>
        </button>
      </li>
    )
  }

  const ongoingEvents = showAllDayGroup ? events.filter((e) => !e.all_day && ongoingIds?.has(e.id)) : []
  const allDayEvents = showAllDayGroup ? events.filter((e) => e.all_day) : []
  const upcomingEvents = showAllDayGroup ? events.filter((e) => !e.all_day && !ongoingIds?.has(e.id)) : []

  return (
    <>
      {showAllDayGroup ? (
        allDayEvents.length === 0 ? (
          <ul className="divide-y divide-[#e5ebe2]">
            {[...ongoingEvents, ...upcomingEvents].map(renderItem)}
          </ul>
        ) : (
          <>
            {ongoingEvents.length > 0 && (
              <ul className="divide-y divide-[#e5ebe2]">
                {ongoingEvents.map(renderItem)}
              </ul>
            )}
            <div
              className={`${ongoingEvents.length > 0 ? 'my-3' : 'mb-3'} rounded-2xl border border-[#dce6d9] bg-[#f9fbf8] p-4`}
              aria-label="Eventos de todo el día"
            >
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#4f8068]">
                Todo el día
              </h3>
              <ul className="mt-2 divide-y divide-[#e2ece0]">
                {allDayEvents.map(renderItem)}
              </ul>
            </div>
            {upcomingEvents.length > 0 && (
              <ul className="divide-y divide-[#e5ebe2]">
                {upcomingEvents.map(renderItem)}
              </ul>
            )}
          </>
        )
      ) : (
        <ul className="divide-y divide-[#e5ebe2]">
          {events.map(renderItem)}
        </ul>
      )}

      {selected && (
        <FormDialog title="Detalle del evento" onClose={() => setSelectedId(null)}>
          <div className="p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <h2 className="min-w-0 break-words text-2xl font-semibold text-[#173f31]">{selected.title}</h2>
              <button
                className="min-h-11 shrink-0 px-2 font-semibold text-[#52675d]"
                data-dialog-initial-focus
                onClick={() => setSelectedId(null)}
                type="button"
              >
                Cerrar
              </button>
            </div>
            <p className="mt-4 leading-7 text-[#52675d]">
              {eventTimeLabel(selected)}{selected.all_day ? '' : ' · America/Bogota'}
            </p>
            <p className="mt-2 break-words text-sm text-[#718279]">{calendarName(selected.calendar_id)}</p>
            {selected.location && <p className="mt-4 break-words text-sm text-[#52675d]">Ubicación: {selected.location}</p>}
            {selected.description && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-7 text-[#66796f]">{selected.description}</p>}
            {link && <a className="mt-5 inline-block break-all font-semibold text-[#346a52] underline" href={link} target="_blank" rel="noopener noreferrer">Abrir enlace del evento</a>}
            <p className="mt-6 text-xs text-[#829188]">Solo visualización. Administra este evento desde tu calendario habitual.</p>
          </div>
        </FormDialog>
      )}
    </>
  )
}
