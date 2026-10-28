import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useBogotaToday } from '../tasks/useBogotaToday'
import { getBogotaToday } from '../finance/calculations'
import { useCalendarAgenda } from '../calendar/useCalendarAgenda'
import { calendarWeekStart, getTodaySummaryEvents } from '../calendar/dates'
import { useSummaryClock } from '../calendar/useSummaryClock'
import { CalendarEvents } from './CalendarEvents'
import { formatTaskInstant } from '../tasks/calculations'

export function HomeCalendar() {
  const now = useSummaryClock()
  const hookedToday = useBogotaToday()
  const today = hookedToday || getBogotaToday(now)
  const calendar = useCalendarAgenda(calendarWeekStart(today))

  const summary = useMemo(() => {
    return getTodaySummaryEvents(calendar.events, now, today, 5)
  }, [calendar.events, now, today])

  const ongoingIds = useMemo(() => {
    return new Set(summary.ongoing.map((event) => event.id))
  }, [summary.ongoing])

  const providers = [
    { label: 'iCloud', value: calendar.icloud },
    { label: 'Google', value: calendar.google },
  ]

  return (
    <section className="mt-8 rounded-[24px] border border-[#dce6d9] bg-white p-5 sm:p-6" aria-labelledby="home-calendar-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-[#173f31]" id="home-calendar-title">
            Eventos de hoy
          </h2>
          <p className="mt-2 text-sm text-[#66796f]">
            iCloud y Google · {today} · America/Bogota · separado de tus tareas.
          </p>
        </div>
        <Link className="min-h-11 rounded-xl bg-[#edf3ea] px-4 py-3 text-sm font-semibold text-[#315c49]" to="/calendario">
          Ver calendario
        </Link>
      </div>

      {calendar.loading ? (
        <p className="mt-4 text-sm" role="status">Cargando eventos…</p>
      ) : !calendar.hasWindow ? (
        <p className="mt-4 text-sm text-[#718279]">
          Conecta y selecciona calendarios desde Calendario para consultar tus eventos.
        </p>
      ) : summary.allVisible.length > 0 ? (
        <CalendarEvents
          calendars={calendar.calendars}
          events={summary.allVisible}
          ongoingIds={ongoingIds}
          showAllDayGroup
        />
      ) : (
        <p className="mt-4 text-sm text-[#718279]">
          No tienes más eventos programados para hoy
        </p>
      )}

      {summary.totalEligibleCount > summary.allVisible.length && (
        <p className="mt-3 text-sm text-[#718279]">
          Mostrando {summary.allVisible.length} de {summary.totalEligibleCount}. Consulta el resto en Calendario.
        </p>
      )}

      <div className="mt-4 space-y-1 text-xs leading-5 text-[#718279]">
        {providers.map(({ label, value }) => (
          <p key={label}>
            {label}: {value.window
              ? `última copia de la semana ${formatTaskInstant(value.window.synced_at)} · Bogotá.`
              : value.ready === false
                ? 'configuración pendiente o servicio no disponible.'
                : value.connection?.status === 'connected'
                  ? 'sin copia de esta semana.'
                  : 'sin conectar.'}
            {value.error || value.connection?.error_code || value.connection?.status === 'reconnect'
              ? ' La copia puede estar desactualizada; revisa esta conexión en Calendario.'
              : ''}
          </p>
        ))}
      </div>
      <p className="mt-4 text-xs leading-5 text-[#829188]">
        Los cambios externos aparecen después de sincronizar cada proveedor. Este listado no modifica eventos ni tareas.
      </p>
    </section>
  )
}
