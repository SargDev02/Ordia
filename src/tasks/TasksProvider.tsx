import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { supabase } from '../services/supabase'
import { deleteTask, fetchTasks, saveTask, setTaskCompleted } from '../services/tasks'
import type { PersonalTask } from '../types/tasks'
import type { RealtimeStatus } from '../finance/finance-context'
import { TasksContext } from './tasks-context'

// El contenedor de rutas usa key=userId: una nueva sesión recibe estado nuevo desde el primer render.
export function TasksProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [tasks, setTasks] = useState<PersonalTask[]>([])
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting')
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
    // Carga inicial desde el sistema externo; el resto de cambios llega por Realtime o reconexión.
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    let timer: ReturnType<typeof setTimeout>
    const scheduleRefresh = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 120) }
    const onVisible = () => { if (document.visibilityState === 'visible') scheduleRefresh() }
    const channel = supabase?.channel(`tasks:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'personal_tasks', filter: `user_id=eq.${userId}` }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'personal_tasks', filter: `user_id=eq.${userId}` }, scheduleRefresh)
      .subscribe((status) => {
        if (!active.current) return
        setRealtimeStatus(status === 'SUBSCRIBED' ? 'connected' : status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT' ? 'offline' : 'connecting')
        if (status === 'SUBSCRIBED') scheduleRefresh()
      })
    window.addEventListener('online', scheduleRefresh)
    window.addEventListener('focus', scheduleRefresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active.current = false
      sequence.current += 1
      clearTimeout(timer)
      if (channel) void supabase?.removeChannel(channel)
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

  return <TasksContext.Provider value={{ tasks, isLoading, error, realtimeStatus, refresh,
    save: (input, requestId, id) => mutate(() => saveTask(input, requestId, id)),
    complete: (id, completed) => mutate(() => setTaskCompleted(id, completed)),
    remove: (id) => mutate(() => deleteTask(id)),
  }}>{children}</TasksContext.Provider>
}
