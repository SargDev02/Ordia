import { useRef, useState, type FormEvent } from 'react'
import { useTasks } from '../tasks/tasks-context'
import { fromBogotaDateTimeInput, TASK_PRIORITY_LABELS, toBogotaDateTimeInput } from '../tasks/calculations'
import type { PersonalTask, TaskPriority } from '../types/tasks'
import { AuthNotice } from './AuthNotice'
import { FormDialog } from './FormDialog'
import { FormField } from './FormField'

const control = 'w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3 text-base text-[#173f31] focus:outline-[#4f8068]'

export function TaskEditor({ task, onClose }: { task?: PersonalTask; onClose: () => void }) {
  const { save } = useTasks()
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? 'medium')
  const [minutes, setMinutes] = useState(String(task?.estimated_minutes ?? ''))
  const [dueOn, setDueOn] = useState(task?.due_on ?? '')
  const [scheduledAt, setScheduledAt] = useState(toBogotaDateTimeInput(task?.scheduled_at ?? null))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const submitting = useRef(false)

  function close() {
    if (submitting.current) return
    if (dirty && !window.confirm('Tienes cambios sin guardar. ¿Quieres descartarlos?')) return
    onClose()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current) return
    setError('')
    if (!title.trim()) return setError('Escribe un título para la tarea.')
    const duration = minutes === '' ? null : Number(minutes)
    if (duration !== null && (!Number.isInteger(duration) || duration <= 0 || duration > 1000000)) return setError('La duración debe ser un número entero de minutos entre 1 y 1.000.000.')
    submitting.current = true
    setBusy(true)
    try {
      await save({ title: title.trim(), description: description.trim() || null, priority,
        estimated_minutes: duration, due_on: dueOn || null, scheduled_at: fromBogotaDateTimeInput(scheduledAt) }, requestId.current, task?.id)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar la tarea.')
    } finally { submitting.current = false; setBusy(false) }
  }

  return <FormDialog onClose={close} title={task ? 'Editar tarea' : 'Nueva tarea'}>
    <form aria-busy={busy} className="p-6 sm:p-8" onChange={() => setDirty(true)} onSubmit={submit}>
      <div className="mb-6 flex items-start justify-between gap-4"><h2 className="text-2xl font-semibold text-[#173f31]">{task ? 'Editar tarea' : 'Nueva tarea'}</h2><button className="min-h-11 px-2 text-sm font-semibold text-[#52675d]" disabled={busy} onClick={close} type="button">Cerrar</button></div>
      <fieldset className="grid min-w-0 gap-5 sm:grid-cols-2" disabled={busy}>
        <div className="sm:col-span-2"><FormField data-dialog-initial-focus id="task-title" label="Título" maxLength={200} required value={title} onChange={(event) => setTitle(event.target.value)} /></div>
        <div className="sm:col-span-2"><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="task-description">Descripción (opcional)</label><textarea className={control} id="task-description" maxLength={5000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="task-priority">Prioridad</label><select className={control} id="task-priority" value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>{Object.entries(TASK_PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
        <FormField id="task-minutes" label="Duración estimada (minutos, opcional)" min={1} max={1000000} step={1} type="number" value={minutes} onChange={(event) => setMinutes(event.target.value)} />
        <div className="min-w-0"><FormField id="task-due" label="Vencimiento (opcional)" hint="Fecha límite para terminar. Vence al finalizar ese día en Bogotá." type="date" min="1900-01-01" max="9999-12-31" value={dueOn} onChange={(event) => setDueOn(event.target.value)} /></div>
        <div className="min-w-0"><FormField id="task-scheduled" label="Programación (opcional)" hint="Momento en que planeas trabajar. Hora de America/Bogota (UTC−5)." type="datetime-local" min="1900-01-01T00:00" max="9999-12-31T23:59" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></div>
      </fieldset>
      {error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}
      <div className="mt-6 flex justify-end"><button className="min-h-12 rounded-xl bg-[#173f31] px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={busy} type="submit">{busy ? 'Guardando…' : 'Guardar tarea'}</button></div>
    </form>
  </FormDialog>
}
