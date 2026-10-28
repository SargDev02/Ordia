import { Link } from 'react-router-dom'
import { useBogotaToday } from '../tasks/useBogotaToday'
import { useCalendarAgenda } from '../calendar/useCalendarAgenda'
import { calendarWeekStart, eventsOnDay } from '../calendar/dates'
import { CalendarEvents } from './CalendarEvents'
import { formatTaskInstant } from '../tasks/calculations'

export function HomeCalendar() {
  const today = useBogotaToday(); const calendar = useCalendarAgenda(calendarWeekStart(today))
  const events = eventsOnDay(calendar.events, today)
  const providers = [{ label: 'iCloud', value: calendar.icloud }, { label: 'Google', value: calendar.google }]
  return <section className="mt-8 rounded-[24px] border border-[#dce6d9] bg-white p-5 sm:p-6" aria-labelledby="home-calendar-title"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold text-[#173f31]" id="home-calendar-title">Eventos de hoy</h2><p className="mt-2 text-sm text-[#66796f]">iCloud y Google · {today} · America/Bogota · separado de tus tareas.</p></div><Link className="min-h-11 rounded-xl bg-[#edf3ea] px-4 py-3 text-sm font-semibold text-[#315c49]" to="/calendario">Ver calendario</Link></div>
    {calendar.loading ? <p className="mt-4 text-sm" role="status">Cargando eventos…</p> : events.length > 0 ? <CalendarEvents events={events.slice(0, 5)} calendars={calendar.calendars} /> : <p className="mt-4 text-sm text-[#718279]">{calendar.hasWindow ? 'No hay eventos de hoy en las copias disponibles de tus calendarios seleccionados.' : 'Conecta y selecciona calendarios desde Calendario para consultar tus eventos.'}</p>}
    {events.length > 5 && <p className="mt-3 text-sm text-[#718279]">Mostrando 5 de {events.length}. Consulta el resto en Calendario.</p>}
    <div className="mt-4 space-y-1 text-xs leading-5 text-[#718279]">{providers.map(({ label, value }) => <p key={label}>{label}: {value.window ? `última copia de la semana ${formatTaskInstant(value.window.synced_at)} · Bogotá.` : value.ready === false ? 'configuración pendiente o servicio no disponible.' : value.connection?.status === 'connected' ? 'sin copia de esta semana.' : 'sin conectar.'}{value.error || value.connection?.error_code || value.connection?.status === 'reconnect' ? ' La copia puede estar desactualizada; revisa esta conexión en Calendario.' : ''}</p>)}</div>
    <p className="mt-4 text-xs leading-5 text-[#829188]">Los cambios externos aparecen después de sincronizar cada proveedor. Este listado no modifica eventos ni tareas.</p>
  </section>
}
