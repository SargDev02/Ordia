import { useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { useTasks } from '../tasks/tasks-context'
import { useBogotaToday } from '../tasks/useBogotaToday'
import { useSchedulingPreferences } from '../tasks/useSchedulingPreferences'
import { useCalendarAgenda } from '../calendar/useCalendarAgenda'
import { calendarWeekStart } from '../calendar/dates'
import { filterTasks, TASK_PRIORITY_LABELS } from '../tasks/calculations'
import type { PersonalTask, TaskPriority, TaskView } from '../types/tasks'
import { FinanceHeader } from '../components/FinanceHeader'
import { AuthNotice } from '../components/AuthNotice'
import { FormDialog } from '../components/FormDialog'
import { TaskEditor } from '../components/TaskEditor'
import { TaskList } from '../components/TaskList'
import { TaskPlanningSection } from '../components/TaskPlanningSection'
import { AvailabilityDialog } from '../components/AvailabilityDialog'

export default function TasksPage() {
  const { session } = useAuth()
  const userId = session?.user?.id ?? ''
  const tasks = useTasks()
  const today = useBogotaToday()
  const weekStart = calendarWeekStart(today)
  const calendar = useCalendarAgenda(weekStart)
  const schedPrefs = useSchedulingPreferences(userId)

  const [view, setView] = useState<TaskView>('pending')
  const [search, setSearch] = useState('')
  const [priority, setPriority] = useState<TaskPriority | ''>('')
  const [editor, setEditor] = useState<{ task?: PersonalTask } | null>(null)
  const [availabilityOpen, setAvailabilityOpen] = useState(false)
  const [deleting, setDeleting] = useState<PersonalTask | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const rows = filterTasks(tasks.tasks, view, today, search, priority)
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1))
  const views: [TaskView, string][] = [['pending', 'Pendientes'], ['scheduled', 'Programadas'], ['overdue', 'Vencidas'], ['completed', 'Completadas']]

  async function remove() {
    if (!deleting || busy) return
    setBusy(true); setError('')
    try { await tasks.remove(deleting.id); setDeleting(null) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos eliminar la tarea.') }
    finally { setBusy(false) }
  }

  async function handleRefreshCalendars() {
    await Promise.allSettled([
      calendar.icloud.connection?.status === 'connected' && calendar.icloud.calendars.some((c) => c.selected)
        ? calendar.icloud.refresh()
        : null,
      calendar.google.connection?.status === 'connected' && calendar.google.calendars.some((c) => c.selected)
        ? calendar.google.refresh()
        : null,
    ])
  }

  return <div className="min-h-screen bg-[#f4f7f1]">
    <FinanceHeader realtimeStatus={tasks.realtimeStatus} />
    <main className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#4f8068]">Tu tiempo</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[#173f31]">Tareas</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="min-h-12 rounded-2xl border border-[#d6e1d3] bg-white px-5 py-3 font-semibold text-[#173f31]"
            onClick={() => setAvailabilityOpen(true)}
            type="button"
          >
            Disponibilidad
          </button>
          <button
            className="min-h-12 rounded-2xl bg-[#173f31] px-5 py-3 font-semibold text-white"
            onClick={() => setEditor({})}
            type="button"
          >
            Nueva tarea
          </button>
        </div>
      </div>
      <p className="mt-4 max-w-2xl text-sm leading-6 text-[#66796f]">El vencimiento es tu fecha límite; la programación es el momento en que planeas trabajar. Puedes dejar ambos vacíos. Las fechas y horas se muestran en America/Bogota.</p>
      {tasks.error && <div className="mt-5"><AuthNotice tone="error">{tasks.error}</AuthNotice><button className="mt-3 text-sm font-semibold underline" onClick={() => void tasks.refresh()} type="button">Volver a intentar</button></div>}

      <div className="mt-8">
        <TaskPlanningSection
          tasks={tasks.tasks}
          preferences={schedPrefs.preferences}
          today={today}
          calendarEvents={calendar.events}
          icloudInfo={{
            connected: calendar.icloud.connection?.status === 'connected',
            hasSelected: calendar.icloud.calendars.some((c) => c.selected),
            error: calendar.icloud.error || null,
            syncedAt: calendar.icloud.window?.synced_at ?? null,
            ready: Boolean(calendar.icloud.window),
          }}
          googleInfo={{
            connected: calendar.google.connection?.status === 'connected',
            hasSelected: calendar.google.calendars.some((c) => c.selected),
            error: calendar.google.error || null,
            syncedAt: calendar.google.window?.synced_at ?? null,
            ready: Boolean(calendar.google.window),
          }}
          onOpenAvailability={() => setAvailabilityOpen(true)}
          onScheduleTask={tasks.schedule}
          onRefreshCalendars={handleRefreshCalendars}
          isRefreshingCalendars={Boolean(calendar.icloud.busy || calendar.google.busy)}
        />
      </div>

      <div aria-label="Vistas de tareas" className="mt-8 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">{views.map(([value, label]) => <button aria-pressed={view === value} className={`min-h-11 rounded-xl px-4 py-3 text-sm font-semibold ${view === value ? 'bg-[#173f31] text-white' : 'bg-white text-[#456356]'}`} key={value} onClick={() => { setView(value); setPage(0) }} type="button">{label}</button>)}</div>
      <div className="mt-5 grid gap-4 rounded-2xl bg-white p-4 sm:grid-cols-[2fr_1fr]"><div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="task-search">Buscar por título</label><input className="min-h-12 w-full rounded-xl border border-[#d6e1d3] px-3" id="task-search" type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} /></div><div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="task-filter-priority">Prioridad</label><select className="min-h-12 w-full rounded-xl border border-[#d6e1d3] bg-white px-3" id="task-filter-priority" value={priority} onChange={(event) => { setPriority(event.target.value as TaskPriority | ''); setPage(0) }}><option value="">Todas</option>{Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
      <p aria-live="polite" className="mt-4 text-sm text-[#66796f]">{rows.length} tarea{rows.length === 1 ? '' : 's'} · {view === 'overdue' ? `Vencimiento anterior a ${today}. Hoy aún no está vencido.` : view === 'scheduled' ? 'Pendientes con programación, también si la hora ya pasó.' : view === 'completed' ? 'Historial de tareas realizadas; puedes desmarcarlas.' : 'Todas las tareas sin completar, incluidas las que no tienen fechas.'}</p>
      <section aria-label="Lista de tareas" className="mt-4 rounded-[24px] border border-[#dce6d9] bg-white px-5 py-2 sm:px-6">
        {tasks.isLoading ? <p className="py-8 text-sm" role="status">Cargando tus tareas…</p> : rows.length === 0 ? <div className="py-10 text-center"><p className="font-semibold text-[#456356]">No hay tareas en esta vista</p><p className="mt-2 text-sm text-[#718279]">Crea una tarea o ajusta los filtros.</p></div> : <TaskList tasks={rows.slice(currentPage * 20, (currentPage + 1) * 20)} today={today} onEdit={(task) => setEditor({ task })} onDelete={(task) => { setDeleting(task); setError('') }} />}
      </section>
      {rows.length > 20 && <nav aria-label="Páginas de tareas" className="mt-4 flex items-center justify-between gap-3 text-sm"><button className="min-h-11 px-3 disabled:opacity-40" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} type="button">Anterior</button><span>Página {currentPage + 1} de {Math.ceil(rows.length / 20)}</span><button className="min-h-11 px-3 disabled:opacity-40" disabled={(currentPage + 1) * 20 >= rows.length} onClick={() => setPage(currentPage + 1)} type="button">Siguiente</button></nav>}
    </main>
    {editor && <TaskEditor task={editor.task} onClose={() => setEditor(null)} />}
    {availabilityOpen && (
      <AvailabilityDialog
        userId={userId}
        preferences={schedPrefs.preferences}
        onSave={schedPrefs.save}
        onClose={() => setAvailabilityOpen(false)}
      />
    )}
    {deleting && <FormDialog title="Eliminar tarea" onClose={() => { if (!busy) setDeleting(null) }}><div className="p-6 sm:p-8"><h2 className="text-2xl font-semibold text-[#173f31]">¿Eliminar “{deleting.title}”?</h2><p className="mt-4 leading-7 text-[#66796f]">La tarea dejará de aparecer en tus listas. Se conservará mediante baja lógica.</p>{error && <div className="mt-4"><AuthNotice tone="error">{error}</AuthNotice></div>}<div className="mt-6 flex flex-wrap justify-end gap-3"><button className="min-h-11 rounded-xl border px-4" data-dialog-initial-focus disabled={busy} onClick={() => setDeleting(null)} type="button">Cancelar</button><button className="min-h-11 rounded-xl bg-[#8b3b31] px-4 font-semibold text-white disabled:opacity-60" disabled={busy} onClick={() => void remove()} type="button">{busy ? 'Eliminando…' : 'Confirmar eliminación'}</button></div></div></FormDialog>}
  </div>
}
