import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CalendarPage from './CalendarPage'

const mocks = vi.hoisted(() => ({ run: vi.fn(), refresh: vi.fn(), connected: true, googleConnected: false, googleError: '' }))
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ session: { user: { email: 'ordia@example.test' } }, signOut: vi.fn() }) }))
vi.mock('../tasks/useBogotaToday', () => ({ useBogotaToday: () => '2026-10-27' }))
vi.mock('../calendar/useIcloudCalendar', () => ({ useIcloudCalendar: () => ({
  connection: mocks.connected ? { id: 'c', generation: 'g', status: 'connected', error_code: null } : null,
  calendars: [{ id: 's', name: 'Personal', color: '#123456', selected: true }],
  events: mocks.connected ? [{ id: 'e', calendar_id: 's', title: '<script>Evento</script>', description: '<img src=x onerror=alert(1)>', location: 'Bogotá', url: 'javascript:alert(1)', all_day: true, start_on: '2026-10-27', end_on: '2026-10-28' }] : [],
  window: { synced_at: '2026-10-27T14:00:00Z' }, loading: false, error: '', ready: true, busy: '', realtimeStatus: 'connected', run: mocks.run, refresh: mocks.refresh,
}) }))
vi.mock('../calendar/useGoogleCalendar', () => ({ useGoogleCalendar: () => ({
  connection: mocks.googleConnected ? { id: 'c', generation: 'g', status: 'connected', error_code: null } : null,
  calendars: mocks.googleConnected ? [{ id: 's', name: 'Trabajo', color: '#123456', selected: true }] : [],
  events: mocks.googleConnected ? [{ id: 'e', occurrence_key: 'one', calendar_id: 's', title: '<script>Evento</script>', description: '', location: '', url: null, all_day: true, start_on: '2026-10-27', end_on: '2026-10-28' }] : [],
  window: mocks.googleConnected ? { synced_at: '2026-10-27T14:00:00Z' } : null, loading: false, error: mocks.googleError, ready: false, busy: '', realtimeStatus: 'connected', run: vi.fn(), refresh: vi.fn(),
}) }))
beforeEach(() => { vi.clearAllMocks(); mocks.connected = true; mocks.googleConnected = false; mocks.googleError = ''; mocks.run.mockResolvedValue(undefined); mocks.refresh.mockResolvedValue(undefined); vi.stubGlobal('isSecureContext', true) })

describe('agenda y conexión privadas', () => {
  it('presenta únicamente una referencia de error válida y conserva la agenda iCloud', () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    render(<MemoryRouter initialEntries={[`/calendario?google=error&google_error_id=${id}`]}><CalendarPage /></MemoryRouter>)
    expect(screen.getByText(new RegExp(`Referencia del error: ${id}`))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /<script>Evento/ })).toBeInTheDocument()
  })
  it('muestra detalle de solo lectura, escapa contenido externo y bloquea enlaces inseguros', async () => {
    const user = userEvent.setup(); const { container } = render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: /<script>Evento/ }))
    const dialog = screen.getByRole('dialog', { name: 'Detalle del evento' })
    expect(within(dialog).getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(within(dialog).queryByRole('link', { name: 'Abrir enlace del evento' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Editar/ })).not.toBeInTheDocument()
    expect(container.querySelector('script,img')).toBeNull()
    await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('acepta un correo Apple distinto, conserva el formulario ante error y confirma descartarlo', async () => {
    mocks.connected = false; mocks.run.mockRejectedValueOnce(new Error('Credencial rechazada'))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup(); render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: 'Conectar iCloud' }))
    const dialog = screen.getByRole('dialog', { name: 'Conectar iCloud' })
    await user.type(within(dialog).getByLabelText('Correo de tu Apple Account'), 'apple@example.test')
    await user.type(within(dialog).getByLabelText('Contraseña específica de aplicación'), 'aaaa-bbbb-cccc-dddd')
    await user.click(within(dialog).getByRole('button', { name: 'Conectar iCloud' }))
    expect(await screen.findByText('Credencial rechazada')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Correo de tu Apple Account')).toHaveValue('apple@example.test')
    await user.keyboard('{Escape}'); expect(dialog).toBeInTheDocument(); expect(confirm).toHaveBeenCalled()
    confirm.mockRestore()
  })
  it('guarda ninguna selección y pide confirmación antes de desconectar', async () => {
    const user = userEvent.setup(); render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: 'Elegir calendarios de iCloud' }))
    await user.click(screen.getByRole('checkbox', { name: 'Personal' }))
    await user.click(screen.getByRole('button', { name: 'Guardar selección' }))
    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith('select', { ids: [] }))
    await user.click(screen.getByRole('button', { name: 'Desconectar iCloud' }))
    expect(mocks.run).not.toHaveBeenCalledWith('disconnect')
    await user.click(screen.getByRole('button', { name: 'Confirmar desconexión' }))
    expect(mocks.run).toHaveBeenCalledWith('disconnect')
  })
  it('combina proveedores sin fusionar eventos iguales y conserva iCloud ante un error Google', () => {
    mocks.googleConnected = true; mocks.googleError = 'Google no responde'
    render(<MemoryRouter><CalendarPage /></MemoryRouter>)
    const buttons = screen.getAllByRole('button', { name: /<script>Evento/ })
    expect(buttons).toHaveLength(2)
    expect(buttons.some((button) => button.textContent?.includes('iCloud · Personal'))).toBe(true)
    expect(buttons.some((button) => button.textContent?.includes('Google · Trabajo'))).toBe(true)
    expect(screen.getByText('Google no responde')).toBeInTheDocument()
  })
})
