import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../services/supabase'
import { fetchSchedulingPreferences, saveSchedulingPreferences } from '../services/tasks'
import type { TaskSchedulingPreferences } from '../types/tasks'

export function useSchedulingPreferences(userId: string) {
  const [preferences, setPreferences] = useState<TaskSchedulingPreferences | null>(null)
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const active = useRef(false)

  const refresh = useCallback(async () => {
    if (!userId) {
      setLoading(false)
      return
    }
    try {
      const data = await fetchSchedulingPreferences(userId)
      if (!active.current) return
      setPreferences(data)
      setError('')
    } catch (caught) {
      if (active.current) {
        setError(caught instanceof Error ? caught.message : 'No pudimos cargar tus preferencias.')
      }
    } finally {
      if (active.current) setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    active.current = true
    if (!userId) {
      // oxlint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false)
      return
    }
    void refresh()

    let timer: ReturnType<typeof setTimeout>
    const scheduleRefresh = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void refresh(), 100)
    }

    const channel = supabase?.channel(`task_scheduling_prefs:${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'task_scheduling_preferences',
        filter: `user_id=eq.${userId}`,
      }, scheduleRefresh)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'task_scheduling_preferences',
        filter: `user_id=eq.${userId}`,
      }, scheduleRefresh)
      .subscribe()

    window.addEventListener('focus', scheduleRefresh)

    return () => {
      active.current = false
      clearTimeout(timer)
      if (channel) void supabase?.removeChannel(channel)
      window.removeEventListener('focus', scheduleRefresh)
    }
  }, [refresh, userId])

  const save = async (input: Omit<TaskSchedulingPreferences, 'created_at' | 'updated_at'>) => {
    const saved = await saveSchedulingPreferences(input)
    if (active.current) {
      setPreferences(saved)
    }
    return saved
  }

  return { preferences, isLoading, error, refresh, save }
}
