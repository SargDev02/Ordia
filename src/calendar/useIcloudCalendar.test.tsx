import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarSnapshot } from '../types/calendar'
import { useIcloudCalendar } from './useIcloudCalendar'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), invoke: vi.fn(), remove: vi.fn(), callbacks: [] as (() => void)[] }))
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ session: { user: { id: 'a' } } }) }))
vi.mock('../services/calendar', () => ({ fetchCalendarSnapshot: mocks.fetch, invokeCalendar: mocks.invoke }))
vi.mock('../services/supabase', () => ({ supabase: { channel: () => {
  const channel = { on: (_event: string, _filter: unknown, callback: () => void) => { mocks.callbacks.push(callback); return channel }, subscribe: () => channel }; return channel
}, removeChannel: mocks.remove } }))

function snapshot(): CalendarSnapshot {
  return { connection: { id: 'c', user_id: 'a', generation: 'g', status: 'connected', error_code: null, updated_at: '' },
    calendars: [{ id: 's', user_id: 'a', connection_id: 'c', name: 'Personal', color: '#123456', selected: true }],
    window: { id: 'w', user_id: 'a', connection_id: 'c', generation: 'g', start_on: '2026-10-26', end_on: '2026-11-02', synced_at: '2026-10-27T14:00:00Z' },
    events: [{ id: 'e', user_id: 'a', calendar_id: 's', window_id: 'w', occurrence_key: 'one', title: 'Copia válida', description: '', location: '', url: null, all_day: true, starts_at: null, ends_at: null, start_on: '2026-10-27', end_on: '2026-10-28' }] }
}
beforeEach(() => { vi.clearAllMocks(); mocks.callbacks = []; mocks.fetch.mockResolvedValue(snapshot()); mocks.invoke.mockResolvedValue({ configured: true }) })

describe('copia de calendario y recuperación (mocks)', () => {
  it('conserva la última copia si sincronizar falla y limita actualizaciones al volver', async () => {
    mocks.invoke.mockImplementation((action: string) => action === 'sync' ? Promise.reject(new Error('iCloud no responde')) : Promise.resolve({ configured: true }))
    const { result, unmount } = renderHook(() => useIcloudCalendar('2026-10-26'))
    await waitFor(() => expect(result.current.error).toBe('iCloud no responde'))
    expect(result.current.events[0].title).toBe('Copia válida')
    const calls = mocks.invoke.mock.calls.length
    act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
    expect(mocks.invoke).toHaveBeenCalledTimes(calls)
    unmount(); expect(mocks.remove).toHaveBeenCalledOnce()
  })
  it('permite desconectar durante sync e ignora el resultado antiguo', async () => {
    let finishSync!: (value: object) => void
    mocks.invoke.mockImplementation((action: string) => action === 'sync' ? new Promise((resolve) => { finishSync = resolve }) : Promise.resolve({ configured: true }))
    const { result } = renderHook(() => useIcloudCalendar('2026-10-26'))
    await waitFor(() => expect(result.current.busy).toBe('sync'))
    mocks.fetch.mockResolvedValue({ connection: { ...snapshot().connection, status: 'disconnected' }, calendars: [], window: null, events: [] })
    await act(async () => { await result.current.run('disconnect') })
    expect(result.current.connection?.status).toBe('disconnected'); expect(result.current.events).toEqual([])
    await act(async () => { finishSync({ ok: true }) })
    expect(result.current.connection?.status).toBe('disconnected'); expect(result.current.events).toEqual([])
  })
  it('no muestra la semana anterior al navegar ni permite una respuesta tardía después de salir', async () => {
    let finish!: (value: CalendarSnapshot) => void
    mocks.fetch.mockResolvedValueOnce({ ...snapshot(), calendars: [] }).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const { result, rerender, unmount } = renderHook(({ week }) => useIcloudCalendar(week), { initialProps: { week: '2026-10-26' } })
    await waitFor(() => expect(result.current.events).toHaveLength(1))
    rerender({ week: '2026-11-02' })
    expect(result.current.events).toEqual([]); expect(result.current.loading).toBe(true)
    unmount()
    await act(async () => { finish(snapshot()) })
    expect(mocks.remove).toHaveBeenCalledTimes(2)
  })
})
