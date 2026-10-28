import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGoogleCalendar } from './useGoogleCalendar'
import type { CalendarSnapshot } from '../types/calendar'

const mocks = vi.hoisted(() => ({ owner: 'a', fetch: vi.fn(), invoke: vi.fn(), remove: vi.fn(), callbacks: [] as (() => void)[] }))
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ session: { user: { id: mocks.owner } } }) }))
vi.mock('../services/googleCalendar', () => ({ fetchGoogleSnapshot: mocks.fetch, invokeGoogleCalendar: mocks.invoke }))
vi.mock('../services/supabase', () => ({ supabase: { channel: () => {
  const channel = { on: (_event: string, _filter: unknown, callback: () => void) => { mocks.callbacks.push(callback); return channel }, subscribe: () => channel }; return channel
}, removeChannel: mocks.remove } }))
const snapshot = (owner: string): CalendarSnapshot => ({ connection: { id: owner, user_id: owner, generation: 'g', status: 'connected', error_code: null, updated_at: '' },
  calendars: [{ id: `cal-${owner}`, user_id: owner, connection_id: owner, selected: true, name: owner, color: '#123456' }], window: null,
  events: [{ id: owner, user_id: owner, window_id: 'w', calendar_id: `cal-${owner}`, occurrence_key: owner, title: `Evento ${owner}`, description: '', location: '', url: null, all_day: true, start_on: '2026-10-27', end_on: '2026-10-28', starts_at: null, ends_at: null }] })
beforeEach(() => { vi.clearAllMocks(); mocks.owner = 'a'; mocks.callbacks = []; mocks.invoke.mockResolvedValue({ configured: true }); mocks.fetch.mockImplementation(async (owner: string) => snapshot(owner)) })

describe('estado de Google por sesión (mocks)', () => {
  it('oculta A inmediatamente al cambiar a B y descarta respuestas y canales de A', async () => {
    const { result, rerender } = renderHook(() => useGoogleCalendar('2026-10-26'))
    await waitFor(() => expect(result.current.events[0]?.title).toBe('Evento a'))
    await waitFor(() => expect(result.current.busy).toBe(''))
    let finish!: (data: CalendarSnapshot) => void
    mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    let refresh!: Promise<unknown>
    act(() => { refresh = result.current.refresh() })
    await waitFor(() => expect(finish).toBeDefined())
    mocks.owner = 'b'; rerender()
    expect(result.current.events.every((event) => event.user_id !== 'a')).toBe(true)
    await waitFor(() => expect(result.current.events[0]?.title).toBe('Evento b'))
    await act(async () => { finish(snapshot('a')); await refresh })
    expect(result.current.events[0]?.title).toBe('Evento b')
    expect(mocks.remove).toHaveBeenCalled()
  })
  it('ignora una sincronización antigua al desconectar y conserva solo el aviso de revocación pendiente', async () => {
    let finish!: (data: object) => void
    mocks.invoke.mockImplementation((action: string) => action === 'sync' ? new Promise((resolve) => { finish = resolve }) : Promise.resolve({ configured: true, ...(action === 'disconnect' ? { revocation_pending: true } : {}) }))
    const { result } = renderHook(() => useGoogleCalendar('2026-10-26'))
    await waitFor(() => expect(result.current.busy).toBe('sync'))
    mocks.fetch.mockResolvedValue({ connection: { ...snapshot('a').connection, status: 'disconnected' }, calendars: [], window: null, events: [] })
    await act(async () => { await result.current.run('disconnect') })
    await act(async () => { finish({ ok: true }) })
    expect(result.current.events).toEqual([]); expect(result.current.connection?.status).toBe('disconnected')
    expect(result.current.error).toContain('no pudimos confirmar la revocación')
  })
})
