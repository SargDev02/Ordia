import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { supabase } from '../services/supabase'
import type { CalendarSnapshot } from '../types/calendar'
import type { RealtimeStatus } from '../finance/finance-context'

const empty: CalendarSnapshot = { connection: null, calendars: [], window: null, events: [] }

export interface CalendarResponse { configured?: boolean; authorization_ticket?: string; authorization_endpoint?: string; revocation_pending?: boolean }
export function useCalendarProvider(provider: 'icloud' | 'google', startOn: string,
  fetchSnapshot: (userId: string, startOn: string) => Promise<CalendarSnapshot>,
  invoke: (action: string, payload?: Record<string, unknown>) => Promise<CalendarResponse>) {
  const { session } = useAuth(); const userId = session?.user.id ?? ''
  const [stored, setStored] = useState<{ owner: string; week: string; data: CalendarSnapshot } | null>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState<boolean | null>(null)
  const [settledWeek, setSettledWeek] = useState('')
  const [busy, setBusy] = useState('')
  const [realtimeStatus, setRealtime] = useState<RealtimeStatus>('connecting')
  const active = useRef(false); const sequence = useRef(0); const operation = useRef(0); const busyRef = useRef('')

  const load = useCallback(async () => {
    const seq = ++sequence.current
    try {
      const data = await fetchSnapshot(userId, startOn)
      if (active.current && seq === sequence.current) { setStored({ owner: userId, week: startOn, data }); setSettledWeek(`${userId}:${startOn}`) }
      return data
    } catch (caught) {
      if (active.current && seq === sequence.current) { setError(caught instanceof Error ? caught.message : 'No pudimos cargar el calendario.'); setSettledWeek(`${userId}:${startOn}`) }
      return null
    }
  }, [userId, startOn, fetchSnapshot])

  const run = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    if (busyRef.current && action !== 'disconnect') throw new Error('Hay una operación de calendario en curso. Espera un momento y vuelve a intentar.')
    const id = ++operation.current
    busyRef.current = action; setBusy(action); setError('')
    try {
      const response = await invoke(action, { start_on: startOn, ...payload })
      if (!active.current || operation.current !== id) return
      if (action === 'start') return response
      const data = await load()
      if (['connect', 'discover', 'select'].includes(action) && data?.connection?.status === 'connected' && data.calendars.some((calendar) => calendar.selected)) {
        await invoke('sync', { start_on: startOn })
        if (active.current && operation.current === id) await load()
      }
      if (response.revocation_pending) setError('Se borró la conexión de Ordia, pero no pudimos confirmar la revocación en Google. Revisa las aplicaciones con acceso a tu cuenta Google.')
      return response
    } catch (caught) {
      if (active.current && operation.current === id) { setError(caught instanceof Error ? caught.message : 'No pudimos completar la operación del calendario.'); await load() }
      throw caught
    } finally {
      if (operation.current === id) { busyRef.current = ''; if (active.current) setBusy('') }
    }
  }, [load, startOn, invoke])

  useEffect(() => {
    const requests = sequence; const operations = operation
    active.current = true
    let alive = true
    // El efecto conecta y reinicia el estado de una ventana externa distinta.
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    setBusy('')
    let timer: ReturnType<typeof setTimeout>
    let lastAutomatic = 0
    async function automatic() {
      if (busyRef.current || Date.now() - lastAutomatic < 60000) return
      lastAutomatic = Date.now()
      const data = await load()
      if (!alive) return
      if (data?.connection?.status === 'connected' && data.calendars.some((calendar) => calendar.selected)) {
        await run('sync').catch(() => undefined)
      }
    }
    void invoke('status').then((result) => { if (alive) setReady(result.configured === true) }).catch((caught) => {
      if (alive) { setReady(false); setError(caught instanceof Error ? caught.message : 'Servicio de calendario pendiente.') }
    })
    void automatic()
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void load(), 120) }
    const visible = () => { if (document.visibilityState === 'visible') void automatic() }
    const channel = supabase?.channel(`${provider}-cache:${userId}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: `${provider}_connections`, filter: `user_id=eq.${userId}` }, schedule)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: `${provider}_connections`, filter: `user_id=eq.${userId}` }, schedule)
      .subscribe((status) => {
        if (!alive) return
        if (status === 'SUBSCRIBED') { setRealtime('connected'); schedule() }
        else if (['CLOSED', 'TIMED_OUT', 'CHANNEL_ERROR'].includes(status)) setRealtime('offline')
      })
    window.addEventListener('focus', visible); window.addEventListener('online', visible); document.addEventListener('visibilitychange', visible)
    return () => {
      alive = false; active.current = false; requests.current++; operations.current++; busyRef.current = ''; clearTimeout(timer)
      if (channel) void supabase?.removeChannel(channel)
      window.removeEventListener('focus', visible); window.removeEventListener('online', visible); document.removeEventListener('visibilitychange', visible)
    }
  }, [load, run, userId, provider, invoke])

  const own = stored?.owner === userId ? stored : null
  const snapshot = own?.week === startOn ? own.data : { ...empty, connection: own?.data.connection ?? null, calendars: own?.data.calendars ?? [] }
  return { ...snapshot, error, ready, loading: settledWeek !== `${userId}:${startOn}`, busy, realtimeStatus, run,
    refresh: () => run('sync', { force: true }) }
}
