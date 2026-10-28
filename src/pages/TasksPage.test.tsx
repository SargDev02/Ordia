import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersonalTask } from '../types/tasks'
import { TasksContext, type TasksState } from '../tasks/tasks-context'
import TasksPage from './TasksPage'
import { HomeTasks } from '../components/HomeTasks'

const mocks = vi.hoisted(() => ({ save: vi.fn(), complete: vi.fn(), remove: vi.fn(), refresh: vi.fn() }))
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ session: { user: { email: 'test@ordia.test' } }, signOut: vi.fn() }) }))
vi.mock('../tasks/useBogotaToday', () => ({ useBogotaToday: () => '2026-10-27' }))

function task(overrides: Partial<PersonalTask> = {}): PersonalTask {
  return { id: 'a', user_id: 'a', client_request_id: 'a', title: 'Leer', description: null, priority: 'medium', estimated_minutes: null, due_on: '2026-10-27', scheduled_at: null, completed_at: null, is_completed: false, deleted_at: null, created_at: '', updated_at: '', ...overrides }
}
function renderTasks(tasks: PersonalTask[] = [], home = false) {
  const state: TasksState = { tasks, isLoading: false, error: '', realtimeStatus: 'connected', ...mocks }
  return render(<MemoryRouter><TasksContext.Provider value={state}>{home ? <HomeTasks /> : <TasksPage />}</TasksContext.Provider></MemoryRouter>)
}

beforeEach(() => { vi.clearAllMocks(); mocks.save.mockResolvedValue(undefined); mocks.complete.mockResolvedValue(undefined); mocks.remove.mockResolvedValue(undefined) })

describe('formularios y checklist de tareas', () => {
  it('rechaza un título vacío y bloquea dos envíos simultáneos', async () => {
    const user = userEvent.setup()
    let finish!: () => void
    mocks.save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    renderTasks(); await user.click(screen.getByRole('button', { name: 'Nueva tarea' }))
    const dialog = screen.getByRole('dialog', { name: 'Nueva tarea' })
    await user.type(within(dialog).getByLabelText('Título'), '   ')
    await user.click(within(dialog).getByRole('button', { name: 'Guardar tarea' }))
    expect(screen.getByText('Escribe un título para la tarea.')).toBeInTheDocument()
    await user.clear(within(dialog).getByLabelText('Título')); await user.type(within(dialog).getByLabelText('Título'), 'Una sola vez')
    await user.dblClick(within(dialog).getByRole('button', { name: 'Guardar tarea' }))
    expect(mocks.save).toHaveBeenCalledOnce()
    finish()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
  it('crea sin fechas, conserva los campos tras un error y reutiliza la petición al reintentar', async () => {
    const user = userEvent.setup(); mocks.save.mockRejectedValueOnce(new Error('Sin conexión'))
    renderTasks()
    const opener = screen.getByRole('button', { name: 'Nueva tarea' }); await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Nueva tarea' })
    expect(within(dialog).getByLabelText('Título')).toHaveFocus()
    await user.type(within(dialog).getByLabelText('Título'), 'Comprar pan')
    await user.click(within(dialog).getByRole('button', { name: 'Guardar tarea' }))
    expect(await screen.findByText('Sin conexión')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Título')).toHaveValue('Comprar pan')
    await user.click(within(dialog).getByRole('button', { name: 'Guardar tarea' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.save.mock.calls[0][0]).toEqual({ title: 'Comprar pan', description: null, priority: 'medium', estimated_minutes: null, due_on: null, scheduled_at: null })
    expect(mocks.save.mock.calls[0][1]).toBe(mocks.save.mock.calls[1][1])
    expect(opener).toHaveFocus()
  })

  it('confirma el descarte y permite editar con programación explícita de Bogotá', async () => {
    const user = userEvent.setup(); const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true)
    renderTasks([task({ scheduled_at: '2026-10-28T04:00:00Z' })])
    await user.click(screen.getByRole('button', { name: 'Editar Leer' }))
    const dialog = screen.getByRole('dialog', { name: 'Editar tarea' })
    expect(within(dialog).getByLabelText('Programación (opcional)')).toHaveValue('2026-10-27T23:00')
    await user.type(within(dialog).getByLabelText('Título'), ' más')
    await user.keyboard('{Escape}'); expect(dialog).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Guardar tarea' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalled())
    expect(mocks.save.mock.calls[0][2]).toBe('a')
    expect(confirm).toHaveBeenCalledOnce()
    confirm.mockRestore()
  })

  it('confirma eliminación, permite cancelar y mantiene la confirmación ante errores', async () => {
    const user = userEvent.setup(); renderTasks([task()])
    await user.click(screen.getByRole('button', { name: 'Eliminar Leer' }))
    await user.click(screen.getByRole('button', { name: 'Cancelar' })); expect(mocks.remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Eliminar Leer' }))
    mocks.remove.mockRejectedValueOnce(new Error('Intenta otra vez'))
    await user.click(screen.getByRole('button', { name: 'Confirmar eliminación' }))
    expect(await screen.findByText('Intenta otra vez')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Confirmar eliminación' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(mocks.remove).toHaveBeenLastCalledWith('a')
  })

  it('marca desde el inicio una sola vez y desmarca desde completadas', async () => {
    const user = userEvent.setup()
    const home = renderTasks([task({ scheduled_at: '2026-10-27T15:00:00Z' })], true)
    const box = screen.getByRole('checkbox', { name: 'Completar Leer' })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    await user.click(box); expect(mocks.complete).toHaveBeenLastCalledWith('a', true)
    home.unmount()
    renderTasks([task({ is_completed: true, completed_at: '2026-10-27T15:00:00Z' })])
    await user.click(screen.getByRole('button', { name: 'Completadas' }))
    await user.click(screen.getByRole('checkbox', { name: 'Desmarcar Leer' }))
    expect(mocks.complete).toHaveBeenLastCalledWith('a', false)
  })
})
