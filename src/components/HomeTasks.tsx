import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTasks } from '../tasks/tasks-context'
import { useBogotaToday } from '../tasks/useBogotaToday'
import { selectHomeTasks } from '../tasks/calculations'
import { AuthNotice } from './AuthNotice'
import { TaskEditor } from './TaskEditor'
import { TaskList } from './TaskList'

export function HomeTasks() {
  const { tasks, isLoading, error, refresh } = useTasks()
  const today = useBogotaToday()
  const [creating, setCreating] = useState(false)
  const relevant = selectHomeTasks(tasks, today)
  return <section aria-labelledby="home-tasks-title" className="mt-8 rounded-[24px] border border-[#dce6d9] bg-white p-5 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold text-[#173f31]" id="home-tasks-title">Tus tareas de hoy</h2><p className="mt-2 text-sm leading-6 text-[#66796f]">Programadas para hoy, con vencimiento hoy y vencidas · {today} · Bogotá.</p></div><div className="flex flex-wrap gap-3"><button className="min-h-11 rounded-xl bg-[#173f31] px-4 py-2 text-sm font-semibold text-white" onClick={() => setCreating(true)} type="button">Nueva tarea</button><Link className="min-h-11 px-2 py-3 text-sm font-semibold text-[#346a52] underline" to="/tareas">Consultar todas</Link></div></div>
    {error && <div className="mt-4"><AuthNotice tone="error">{error}</AuthNotice><button className="mt-2 text-sm underline" onClick={() => void refresh()} type="button">Reintentar tareas</button></div>}
    {isLoading ? <p className="mt-4 text-sm" role="status">Cargando tareas…</p> : relevant.length === 0 ? <p className="mt-4 text-sm text-[#718279]">No tienes tareas pendientes para hoy ni vencidas.</p> : <><TaskList tasks={relevant.slice(0, 5)} today={today} />{relevant.length > 5 && <p className="mt-3 text-sm text-[#66796f]">Mostrando 5 de {relevant.length}. <Link className="font-semibold underline" to="/tareas">Ver todas las pendientes</Link></p>}</>}
    {creating && <TaskEditor onClose={() => setCreating(false)} />}
  </section>
}
