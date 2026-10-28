import { getBogotaToday } from '../finance/calculations'
import type { PersonalTask, TaskPriority, TaskView } from '../types/tasks'

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = { low: 'Baja', medium: 'Media', high: 'Alta' }

export function isTaskOverdue(task: PersonalTask, today: string) {
  return !task.deleted_at && !task.is_completed && !!task.due_on && task.due_on < today
}

export function isScheduledToday(task: PersonalTask, today: string) {
  return !!task.scheduled_at && getBogotaToday(new Date(task.scheduled_at)) === today
}

export function selectHomeTasks(tasks: PersonalTask[], today: string) {
  return sortTasks(tasks.filter((task) => !task.deleted_at && !task.is_completed
    && (isTaskOverdue(task, today) || task.due_on === today || isScheduledToday(task, today))))
}

export function filterTasks(tasks: PersonalTask[], view: TaskView, today: string, search = '', priority: TaskPriority | '' = '') {
  return sortTasks(tasks.filter((task) => {
    if (task.deleted_at || !task.title.toLocaleLowerCase('es').includes(search.trim().toLocaleLowerCase('es')) || (priority && task.priority !== priority)) return false
    if (view === 'completed') return task.is_completed
    if (task.is_completed) return false
    if (view === 'overdue') return isTaskOverdue(task, today)
    if (view === 'scheduled') return !!task.scheduled_at
    return true
  }), view === 'completed')
}

function sortTasks(tasks: PersonalTask[], completed = false) {
  const rank = { high: 0, medium: 1, low: 2 }
  return [...tasks].sort((a, b) => completed
    ? (b.completed_at ?? '').localeCompare(a.completed_at ?? '') || a.id.localeCompare(b.id)
    : (a.due_on ?? '9999-12-31').localeCompare(b.due_on ?? '9999-12-31')
      || (a.scheduled_at ?? '9999').localeCompare(b.scheduled_at ?? '9999') || rank[a.priority] - rank[b.priority] || a.id.localeCompare(b.id))
}

// La programación se edita explícitamente en Bogotá, independientemente de la zona del dispositivo.
export function toBogotaDateTimeInput(instant: string | null) {
  if (!instant) return ''
  return new Date(new Date(instant).getTime() - 5 * 60 * 60 * 1000).toISOString().slice(0, 16)
}

export function fromBogotaDateTimeInput(value: string) {
  if (!value) return null
  const instant = new Date(`${value}:00-05:00`)
  if (!Number.isFinite(instant.getTime()) || toBogotaDateTimeInput(instant.toISOString()) !== value) throw new Error('Revisa la fecha y hora programadas.')
  return instant.toISOString()
}

export function formatTaskInstant(instant: string) {
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(instant))
}
