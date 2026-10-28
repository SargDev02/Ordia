import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksProvider } from './TasksProvider'
import { useTasks } from './tasks-context'
import type { PersonalTask } from '../types/tasks'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn(), complete: vi.fn(), remove: vi.fn(), removeChannel: vi.fn(),
  callbacks: [] as (() => void)[], status: undefined as undefined | ((status: string) => void) }))
vi.mock('../services/tasks', () => ({ fetchTasks: mocks.fetch, saveTask: mocks.save, setTaskCompleted: mocks.complete, deleteTask: mocks.remove }))
vi.mock('../services/supabase', () => ({ supabase: {
  channel: () => {
    const channel = { on: (_event: string, _filter: unknown, callback: () => void) => { mocks.callbacks.push(callback); return channel },
      subscribe: (callback: (status: string) => void) => { mocks.status = callback; return channel } }
    return channel
  }, removeChannel: mocks.removeChannel,
} }))

function fixture(user: string, title: string): PersonalTask {
  return { id: title, user_id: user, title, description: null, priority: 'medium', estimated_minutes: null, due_on: null,
    scheduled_at: null, is_completed: false, completed_at: null, deleted_at: null, client_request_id: title, created_at: '', updated_at: '' }
}
function Consumer() {
  const { tasks, isLoading, realtimeStatus } = useTasks()
  return <div><span>{isLoading ? 'Cargando' : 'Listas'}</span><span>{realtimeStatus}</span>{tasks.map((task) => <p key={task.id}>{task.title}</p>)}</div>
}
beforeEach(() => { vi.clearAllMocks(); mocks.callbacks = []; mocks.status = undefined })

describe('sesión y sincronización de tareas', () => {
  it('oculta inmediatamente A al cambiar de sesión y descarta respuestas tardías', async () => {
    let resolveB!: (rows: PersonalTask[]) => void
    let resolveOld!: (rows: PersonalTask[]) => void
    mocks.fetch.mockResolvedValueOnce([fixture('a', 'Privada A')]).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const rendered = render(<TasksProvider key="a" userId="a"><Consumer /></TasksProvider>)
    expect(await screen.findByText('Privada A')).toBeInTheDocument()
    await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise((resolve) => setTimeout(resolve, 150)) })
    mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve }))
    rendered.rerender(<TasksProvider key="b" userId="b"><Consumer /></TasksProvider>)
    expect(screen.queryByText('Privada A')).not.toBeInTheDocument()
    expect(screen.getByText('Cargando')).toBeInTheDocument()
    await act(async () => { resolveOld([fixture('a', 'Respuesta antigua')]); resolveB([fixture('b', 'Privada B'), fixture('a', 'Filtrada A')]) })
    expect(screen.getByText('Privada B')).toBeInTheDocument()
    expect(screen.queryByText('Respuesta antigua')).not.toBeInTheDocument()
    expect(screen.queryByText('Filtrada A')).not.toBeInTheDocument()
    expect(mocks.removeChannel).toHaveBeenCalledOnce()
  })

  it('recupera al reconectar y refleja baja lógica mediante UPDATE', async () => {
    mocks.fetch.mockResolvedValueOnce([fixture('a', 'Pendiente')]).mockResolvedValueOnce([fixture('a', 'Recuperada')]).mockResolvedValueOnce([])
    const rendered = render(<TasksProvider userId="a"><Consumer /></TasksProvider>)
    expect(await screen.findByText('Pendiente')).toBeInTheDocument()
    act(() => { mocks.status?.('SUBSCRIBED') })
    expect(await screen.findByText('Recuperada')).toBeInTheDocument()
    expect(screen.getByText('connected')).toBeInTheDocument()
    act(() => { mocks.callbacks[1]() })
    await waitFor(() => expect(screen.queryByText('Recuperada')).not.toBeInTheDocument())
    const calls = mocks.fetch.mock.calls.length
    rendered.unmount()
    await act(async () => { window.dispatchEvent(new Event('focus')); await new Promise((resolve) => setTimeout(resolve, 150)) })
    expect(mocks.fetch).toHaveBeenCalledTimes(calls)
    expect(mocks.removeChannel).toHaveBeenCalledOnce()
  })
})
