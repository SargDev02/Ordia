import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { deleteTask, fetchTasks, saveTask, scheduleTaskWithCheck, setTaskCompleted } from '../services/tasks'
import type { PersonalTask } from '../types/tasks'
import { TasksContext } from './tasks-context'

// El contenedor de rutas usa key=userId: una nueva sesión recibe estado nuevo desde el primer render.
export function TasksProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [tasks, setTasks] = useState<PersonalTask[]>([])
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const active = useRef(false)

  const refresh = useCallback(async () => {
    const request = ++sequence.current
    try {
      const rows = await fetchTasks()
      if (!active.current || request !== sequence.current) return
      setTasks(rows.filter((task) => task.user_id === userId && !task.deleted_at))
      setError('')
    } catch (caught) {
      if (active.current && request === sequence.current) setError(caught instanceof Error ? caught.message : 'No pudimos cargar tus tareas.')
    } finally {
      if (active.current && request === sequence.current) setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    active.current = true
    // Carga inicial desde Supabase. Las tareas solo cambian por acciones del usuario, que ya
    // recargan en mutate(); otros dispositivos se reflejan al volver a la pestaña o reconectar.
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    let timer: ReturnType<typeof setTimeout>
    const scheduleRefresh = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 120) }
    const onVisible = () => { if (document.visibilityState === 'visible') scheduleRefresh() }
    window.addEventListener('online', scheduleRefresh)
    window.addEventListener('focus', scheduleRefresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active.current = false
      sequence.current += 1
      clearTimeout(timer)
      window.removeEventListener('online', scheduleRefresh)
      window.removeEventListener('focus', scheduleRefresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh, userId])

  async function mutate(operation: () => Promise<PersonalTask>) {
    const row = await operation()
    if (!active.current || row.user_id !== userId) return
    sequence.current += 1 // Invalida consultas anteriores a esta escritura.
    setTasks((current) => row.deleted_at ? current.filter((item) => item.id !== row.id)
      : [...current.filter((item) => item.id !== row.id), row])
    setLoading(false)
    await refresh()
  }

  return <TasksContext.Provider value={{ tasks, isLoading, error, refresh,
    save: (input, requestId, id) => mutate(() => saveTask(input, requestId, id)),
    complete: (id, completed) => mutate(() => setTaskCompleted(id, completed)),
    remove: (id) => mutate(() => deleteTask(id)),
    schedule: (taskId, scheduledAt, expectedUpdatedAt, estimatedMinutes, acceptUnverifiedCalendars) => mutate(() => scheduleTaskWithCheck(taskId, scheduledAt, expectedUpdatedAt, estimatedMinutes, acceptUnverifiedCalendars)),
  }}>{children}</TasksContext.Provider>
}
