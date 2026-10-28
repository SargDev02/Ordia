import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useBogotaToday } from '../tasks/useBogotaToday'
import { useOptionalTasks } from '../tasks/tasks-context'
import { useCalendarAgenda } from '../calendar/useCalendarAgenda'
import { addCalendarDays, calendarDayLabel, calendarWeekStart, eventsOnDay } from '../calendar/dates'
import { getBogotaToday } from '../finance/calculations'
import { formatTaskInstant } from '../tasks/calculations'
import { detectTaskConflict } from '../tasks/scheduling'
import { FinanceHeader } from '../components/FinanceHeader'
import { AuthNotice } from '../components/AuthNotice'
import { CalendarEvents } from '../components/CalendarEvents'
import { CalendarProviderPanel } from '../components/CalendarProviderPanel'
import { TaskEditor } from '../components/TaskEditor'
import type { PersonalTask } from '../types/tasks'

const button = 'min-h-11 rounded-xl border border-[#d6e1d3] bg-white px-4 py-2 text-sm font-semibold text-[#315c49] disabled:opacity-50'

export default function CalendarPage() {
  const today = useBogotaToday(); const previousToday = useRef(today)
  const [date, setDate] = useState(today); const [view, setView] = useState<'day' | 'week'>('week')
  const weekStart = calendarWeekStart(date); const calendar = useCalendarAgenda(weekStart)
  const tasksState = useOptionalTasks()
  const tasks = tasksState?.tasks ?? []
  const schedule = tasksState?.schedule
  const [editingTask, setEditingTask] = useState<PersonalTask | null>(null)
  const [params] = useSearchParams(); const googleResult = params.get('google')
  const errorId = params.get('google_error_id') ?? ''
  const safeErrorId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(errorId) ? errorId : ''
  useEffect(() => {
    if (previousToday.current !== today) {
      const old = previousToday.current; previousToday.current = today
      // Mantiene Hoy siguiendo el día; una fecha elegida manualmente conserva su posición.
      // oxlint-disable-next-line react-hooks/set-state-in-effect
      setDate((current) => current === old ? today : current)
    }
  }, [today])
  const days = view === 'day' ? [date] : Array.from({ length: 7 }, (_, index) => addCalendarDays(weekStart, index))
  const providers = [calendar.icloud, calendar.google]
  const canRefresh = providers.some((provider) => provider.connection?.status === 'connected' && !provider.busy && provider.calendars.some((source) => source.selected))
  function navigate(direction: number) {
    const next = addCalendarDays(date, direction * (view === 'week' ? 7 : 1))
    if (next >= '1900-01-08' && next <= '2099-12-25') setDate(next)
  }
  async function refreshAll() {
    await Promise.allSettled(providers.filter((provider) => provider.connection?.status === 'connected' && !provider.busy && provider.calendars.some((source) => source.selected)).map((provider) => provider.refresh()))
  }
  return <div className="min-h-screen bg-[#f4f7f1]"><FinanceHeader realtimeStatus={calendar.realtimeStatus} /><main className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
    <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#4f8068]">Tu tiempo</p><h1 className="mt-3 text-4xl font-semibold tracking-tight text-[#173f31]">Calendario</h1>
    <p className="mt-4 max-w-3xl text-sm leading-6 text-[#66796f]">Una agenda de iCloud y Google en America/Bogota. Cada proveedor conserva su conexión y selección. Los cambios externos aparecen después de sincronizar; aquí no se editan eventos ni se convierten en tareas.</p>
    {googleResult === 'connected' && calendar.google.connection?.status === 'connected' && <div className="mt-5"><AuthNotice tone="success">Google Calendar quedó conectado. Elige los calendarios que quieres mostrar.</AuthNotice></div>}
    {(googleResult === 'error' || googleResult === 'denied') && <div className="mt-5 break-words"><AuthNotice tone="error">{googleResult === 'denied' ? 'Se canceló la autorización de Google. Tu conexión de iCloud se conserva.' : `No se pudo completar la autorización de Google. Vuelve a intentar; iCloud se conserva.${safeErrorId ? ` Referencia del error: ${safeErrorId}` : ''}`}</AuthNotice></div>}
    <div className="mt-6 grid items-start gap-4 lg:grid-cols-2"><CalendarProviderPanel provider="icloud" calendar={calendar.icloud} /><CalendarProviderPanel provider="google" calendar={calendar.google} /></div>
    <section className="mt-8" aria-label="Agenda unificada"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-wrap gap-2"><button className={button} onClick={() => navigate(-1)} type="button">Anterior</button><button className={button} onClick={() => setDate(today)} type="button">Hoy</button><button className={button} onClick={() => navigate(1)} type="button">Siguiente</button></div><div className="flex gap-2"><button aria-pressed={view === 'day'} className={button} onClick={() => setView('day')} type="button">Día</button><button aria-pressed={view === 'week'} className={button} onClick={() => setView('week')} type="button">Semana</button></div><button className={button} disabled={!canRefresh} onClick={() => void refreshAll()} type="button">Actualizar ambos</button></div>
      <p className="mt-4 text-xs leading-5 text-[#718279]">Las copias se sincronizan por proveedor. Un error en uno no oculta los eventos disponibles del otro. Las selecciones se combinan sin fusionar eventos de igual título y horario.</p>
      <div className="mt-5 grid items-start gap-4 lg:grid-cols-2">{days.map((day) => {
        const events = eventsOnDay(calendar.events, day)
        const dayTasks = tasks.filter((t) => !t.deleted_at && !t.is_completed && t.scheduled_at && getBogotaToday(new Date(t.scheduled_at)) === day).sort((a, b) => (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? ''))
        return <section className="min-w-0 rounded-2xl border border-[#dce6d9] bg-white px-5 py-4" aria-label={calendarDayLabel(day)} key={day}>
          <h2 className="font-semibold capitalize text-[#315c49]">{calendarDayLabel(day)}{day === today ? ' · Hoy' : ''}</h2>
          {events.length > 0 ? <CalendarEvents events={events} calendars={calendar.calendars} /> : <p className="py-4 text-sm text-[#718279]">{calendar.loading ? 'Cargando…' : calendar.hasWindow ? 'Sin eventos en las copias disponibles de los calendarios seleccionados.' : 'No hay una copia disponible para este día.'}</p>}
          {dayTasks.length > 0 && <div className="mt-3 rounded-xl border border-[#dce6d9] bg-[#f8faf6] p-3" aria-label={`Tareas de Ordia programadas para ${calendarDayLabel(day)}`}>
            <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wider text-[#315c49]">Tareas de Ordia programadas</h3><span className="rounded-full bg-[#edf3ea] px-2 py-0.5 text-[11px] font-semibold text-[#4f8068]">{dayTasks.length}</span></div>
            <ul className="mt-2 divide-y divide-[#e2ece0]">{dayTasks.map((t) => {
              const conflict = detectTaskConflict(t, events, 0)
              return <li className="py-2.5" key={t.id}><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-1.5"><span className="font-semibold text-[#264a3c]">{t.title}</span><span className="rounded-full bg-[#edf3ea] px-2 py-0.5 text-[10px] font-semibold text-[#66796f]">Ordia</span>{conflict && <span className="rounded-full bg-[#fce8e6] px-2 py-0.5 text-[10px] font-semibold text-[#a8382c]">Conflicto con {conflict.title}</span>}</div><p className="mt-0.5 text-xs text-[#66796f]">{formatTaskInstant(t.scheduled_at!)}{t.estimated_minutes ? ` · ${t.estimated_minutes} min` : ''}</p></div><div className="flex items-center gap-2"><button aria-label={`Quitar horario de ${t.title}`} className="text-xs font-semibold text-[#8b554d] hover:underline" onClick={() => void schedule?.(t.id, null, t.updated_at)} type="button">Quitar horario</button><button aria-label={`Editar ${t.title}`} className="text-xs font-semibold text-[#346a52] hover:underline" onClick={() => setEditingTask(t)} type="button">Editar</button></div></div></li>
            })}</ul>
          </div>}
        </section>
      })}</div>
      <p className="mt-6 text-xs leading-5 text-[#829188]">La disponibilidad de calendarios externos puede cambiar después de la última sincronización. Las tareas programadas se guardan únicamente en Ordia y no se escriben en iCloud ni Google.</p>
    </section>
    {editingTask && <TaskEditor task={editingTask} onClose={() => setEditingTask(null)} />}
  </main></div>
}
