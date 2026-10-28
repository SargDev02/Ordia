import { useRef, useState } from 'react'
import type { PersonalTask } from '../types/tasks'
import { useTasks } from '../tasks/tasks-context'
import { formatTaskInstant, isTaskOverdue, TASK_PRIORITY_LABELS } from '../tasks/calculations'
import { AuthNotice } from './AuthNotice'

export function TaskList({ tasks, today, onEdit, onDelete }: { tasks: PersonalTask[]; today: string; onEdit?: (task: PersonalTask) => void; onDelete?: (task: PersonalTask) => void }) {
  const { complete } = useTasks()
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const pending = useRef(new Set<string>())
  async function toggle(task: PersonalTask) {
    if (pending.current.has(task.id)) return
    pending.current.add(task.id); setBusyIds(new Set(pending.current)); setError('')
    try { await complete(task.id, !task.is_completed) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos actualizar la tarea.') }
    finally { pending.current.delete(task.id); setBusyIds(new Set(pending.current)) }
  }
  return <div>
    {error && <div className="mb-4"><AuthNotice tone="error">{error}</AuthNotice></div>}
    <ul className="divide-y divide-[#e5ebe2]">{tasks.map((task) => <li className="flex items-start gap-3 py-4" key={task.id}>
      <input aria-label={`${task.is_completed ? 'Desmarcar' : 'Completar'} ${task.title}`} className="mt-1 size-6 shrink-0 accent-[#315c49]" type="checkbox" checked={task.is_completed} disabled={busyIds.has(task.id)} onChange={() => void toggle(task)} />
      <div className="min-w-0 flex-1"><p className={`break-words font-semibold text-[#264a3c] ${task.is_completed ? 'line-through' : ''}`}>{task.title}</p>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5 text-[#66796f]"><span>Prioridad {TASK_PRIORITY_LABELS[task.priority].toLowerCase()}</span>{task.estimated_minutes && <span>{task.estimated_minutes} min</span>}{task.due_on && <span className={isTaskOverdue(task, today) ? 'font-semibold text-[#9a493e]' : ''}>{isTaskOverdue(task, today) ? 'Vencida' : 'Vencimiento'}: {task.due_on}</span>}{task.scheduled_at && <span>Programada: {formatTaskInstant(task.scheduled_at)} · Bogotá</span>}{task.completed_at && <span>Completada: {formatTaskInstant(task.completed_at)} · Bogotá</span>}</div>
        {task.description && onEdit && <p className="mt-2 line-clamp-2 break-words text-sm text-[#718279]">{task.description}</p>}
      </div>
      {onEdit && <div className="flex shrink-0 flex-col sm:flex-row"><button aria-label={`Editar ${task.title}`} className="min-h-11 px-2 text-sm font-semibold text-[#346a52]" onClick={() => onEdit(task)} type="button">Editar</button>{onDelete && <button aria-label={`Eliminar ${task.title}`} className="min-h-11 px-2 text-sm font-semibold text-[#8b554d]" onClick={() => onDelete(task)} type="button">Eliminar</button>}</div>}
    </li>)}</ul>
  </div>
}
