import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersonalTask, TaskSchedulingPreferences } from '../types/tasks'
import { TasksContext, type TasksState } from '../tasks/tasks-context'
import TasksPage from './TasksPage'
import { HomeTasks } from '../components/HomeTasks'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  complete: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  schedule: vi.fn(),
  savePrefs: vi.fn(),
  preferences: null as TaskSchedulingPreferences | null,
}))

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ session: { user: { id: 'u1', email: 'test@ordia.test' } }, signOut: vi.fn() }),
}))
vi.mock('../tasks/useBogotaToday', () => ({ useBogotaToday: () => '2026-10-27' }))
vi.mock('../tasks/useSchedulingPreferences', () => ({
  useSchedulingPreferences: () => ({
    preferences: mocks.preferences,
    loading: false,
    error: '',
    save: mocks.savePrefs,
  }),
}))
vi.mock('../calendar/useCalendarAgenda', () => ({
  useCalendarAgenda: () => ({
    icloud: {
      connection: null,
      calendars: [],
      window: null,
      events: [],
      loading: false,
      error: '',
      ready: false,
      busy: '',
      realtimeStatus: 'connected',
      run: vi.fn(),
      refresh: vi.fn(),
    },
    google: {
      connection: null,
      calendars: [],
      window: null,
      events: [],
      loading: false,
      error: '',
      ready: false,
      busy: '',
      realtimeStatus: 'connected',
      run: vi.fn(),
      refresh: vi.fn(),
    },
    events: [],
    loading: false,
    hasWindow: false,
    realtimeStatus: 'connected',
  }),
}))

function task(overrides: Partial<PersonalTask> = {}): PersonalTask {
  return {
    id: 'a',
    user_id: 'a',
    client_request_id: 'a',
    title: 'Leer',
    description: null,
    priority: 'medium',
    estimated_minutes: null,
    due_on: '2026-10-27',
    scheduled_at: null,
    completed_at: null,
    is_completed: false,
    deleted_at: null,
    created_at: '2026-10-27T10:00:00Z',
    updated_at: '2026-10-27T10:00:00Z',
    ...overrides,
  }
}

function renderTasks(tasks: PersonalTask[] = [], home = false) {
  const state: TasksState = { tasks, isLoading: false, error: '', realtimeStatus: 'connected', ...mocks }
  return render(
    <MemoryRouter>
      <TasksContext.Provider value={state}>
        {home ? <HomeTasks /> : <TasksPage />}
      </TasksContext.Provider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.save.mockResolvedValue(undefined)
  mocks.complete.mockResolvedValue(undefined)
  mocks.remove.mockResolvedValue(undefined)
  mocks.schedule.mockResolvedValue(undefined)
  mocks.savePrefs.mockResolvedValue(undefined)
  mocks.preferences = null
})

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

  it('abre el diálogo de disponibilidad y guarda las franjas horarias', async () => {
    const user = userEvent.setup()
    renderTasks()
    await user.click(screen.getByRole('button', { name: 'Disponibilidad' }))
    const dialog = screen.getByRole('dialog', { name: 'Disponibilidad personal' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText(/America\/Bogota/i)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Guardar disponibilidad' }))
    await waitFor(() => expect(mocks.savePrefs).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('muestra sugerencias de horario para tareas y las programa protegiendo concurrencia', async () => {
    mocks.preferences = {
      user_id: 'u1',
      slots: [{ day_of_week: 3, start_time: '09:00', end_time: '12:00' }],
      buffer_minutes: 15,
      all_day_blocks: true,
      created_at: '',
      updated_at: '',
    }
    const testTask = task({ id: 'task-1', title: 'Diseñar interfaz', estimated_minutes: 60, due_on: '2026-10-28' })
    const user = userEvent.setup()
    renderTasks([testTask])

    expect(screen.getByText('Tareas por organizar')).toBeInTheDocument()
    expect(screen.getAllByText('Diseñar interfaz').length).toBeGreaterThanOrEqual(1)

    // Abrir sugerencias
    await user.click(screen.getByRole('button', { name: 'Sugerir horario' }))
    expect(await screen.findByText(/Opción 1/i)).toBeInTheDocument()

    // Programar la primera alternativa
    const scheduleButtons = screen.getAllByRole('button', { name: /Programar/i })
    await user.click(scheduleButtons[0])

    await waitFor(() => {
      expect(mocks.schedule).toHaveBeenCalledWith(
        'task-1',
        expect.any(String),
        '2026-10-27T10:00:00Z',
        60,
        false,
      )
    })
  })

  it('muestra error cuando ocurre un conflicto de concurrencia al programar', async () => {
    mocks.preferences = {
      user_id: 'u1',
      slots: [{ day_of_week: 3, start_time: '09:00', end_time: '12:00' }],
      buffer_minutes: 15,
      all_day_blocks: true,
      created_at: '',
      updated_at: '',
    }
    mocks.schedule.mockRejectedValueOnce(
      new Error('La tarea fue modificada en otro dispositivo. Hemos actualizado los datos; vuelve a intentar.'),
    )
    const testTask = task({ id: 'task-1', title: 'Diseñar interfaz', estimated_minutes: 60, due_on: '2026-10-28' })
    const user = userEvent.setup()
    renderTasks([testTask])

    await user.click(screen.getByRole('button', { name: 'Sugerir horario' }))
    const scheduleButtons = await screen.findAllByRole('button', { name: /Programar/i })
    await user.click(scheduleButtons[0])

    expect(
      await screen.findByText('La tarea fue modificada en otro dispositivo. Hemos actualizado los datos; vuelve a intentar.'),
    ).toBeInTheDocument()
  })

  it('muestra el vencimiento original y el atraso al aceptar una reprogramación tardía', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T13:00:00Z'))
    try {
      mocks.preferences = {
        user_id: 'u1', slots: [{ day_of_week: 3, start_time: '09:00', end_time: '12:00' }],
        buffer_minutes: 15, all_day_blocks: true, created_at: '', updated_at: '',
      }
      const overdue = task({ estimated_minutes: 60, due_on: '2026-10-26' })
      const user = userEvent.setup()
      renderTasks([overdue])
      expect(screen.getByText('Venció: 2026-10-26')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Sugerir horario' }))
      expect(screen.getAllByText(/Reprogramación tardía.*2026-10-26/).length).toBeGreaterThan(0)
      await user.click(screen.getAllByRole('button', { name: 'Programar en este horario' })[0])
      expect(mocks.schedule).toHaveBeenCalledWith('a', '2026-10-28T14:00:00.000Z', overdue.updated_at, 60, false)
      expect(overdue.due_on).toBe('2026-10-26')
    } finally { vi.useRealTimers() }
  })

  it('mantiene el rechazo de un conflicto conocido tras aceptar calendarios no verificados', async () => {
    mocks.preferences = {
      user_id: 'u1', slots: [{ day_of_week: 3, start_time: '09:00', end_time: '12:00' }],
      buffer_minutes: 15, all_day_blocks: true, created_at: '', updated_at: '',
    }
    mocks.schedule.mockRejectedValueOnce(new Error('No se pudo verificar la disponibilidad completa de tus calendarios.'))
      .mockRejectedValueOnce(new Error('El horario entra en conflicto con el evento: «Reunión».'))
    const user = userEvent.setup()
    renderTasks([task({ estimated_minutes: 60, due_on: '2026-10-28' })])
    await user.click(screen.getByRole('button', { name: 'Sugerir horario' }))
    await user.click(screen.getAllByRole('button', { name: 'Programar en este horario' })[0])
    await user.click(await screen.findByRole('button', { name: /Programar de todos modos sin validar calendarios externos/ }))
    expect(await screen.findByText('El horario entra en conflicto con el evento: «Reunión».')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Programar de todos modos sin validar calendarios externos/ })).not.toBeInTheDocument()
    expect(mocks.schedule).toHaveBeenCalledTimes(2)
    expect(mocks.schedule.mock.calls[1][4]).toBe(true)
  })

  it('permite aceptar únicamente cobertura externa no verificada', async () => {
    mocks.preferences = {
      user_id: 'u1',
      slots: [{ day_of_week: 3, start_time: '09:00', end_time: '12:00' }],
      buffer_minutes: 15,
      all_day_blocks: true,
      created_at: '',
      updated_at: '',
    }
    mocks.schedule
      .mockRejectedValueOnce(
        new Error('No se pudo verificar la disponibilidad completa de tus calendarios (copia desactualizada o con error). Actualiza los calendarios antes de programar.'),
      )
      .mockResolvedValueOnce({
        ...task({ id: 'task-1', scheduled_at: '2026-10-28T14:00:00.000Z' }),
      })
    const testTask = task({ id: 'task-1', title: 'Diseñar interfaz', estimated_minutes: 60, due_on: '2026-10-28' })
    const user = userEvent.setup()
    renderTasks([testTask])

    await user.click(screen.getByRole('button', { name: 'Sugerir horario' }))
    const scheduleButtons = await screen.findAllByRole('button', { name: /Programar en este horario/i })
    await user.click(scheduleButtons[0])

    const forceBtn = await screen.findByRole('button', {
      name: /Programar de todos modos sin validar calendarios externos/i,
    })
    expect(forceBtn).toBeInTheDocument()

    await user.click(forceBtn)
    await waitFor(() => {
      expect(mocks.schedule).toHaveBeenLastCalledWith(
        'task-1',
        expect.any(String),
        '2026-10-27T10:00:00Z',
        60,
        true,
      )
    })
  })
})
