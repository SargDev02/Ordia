import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PushNotificationSettings } from './PushNotificationSettings'

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  activateChannel: vi.fn(),
  deactivate: vi.fn(),
  setChannelPreference: vi.fn(),
  current: vi.fn(),
  devices: vi.fn(),
  configured: true,
  ios: false,
  standalone: true,
  supported: true,
}))

vi.mock('../services/pushNotifications', () => ({
  activatePushChannel: mocks.activateChannel,
  activatePushNotifications: mocks.activate,
  deactivatePushNotifications: mocks.deactivate,
  getCurrentBrowserSubscription: mocks.current,
  isIosDevice: () => mocks.ios,
  isPushConfigured: () => mocks.configured,
  isPushSupported: () => mocks.supported,
  isStandaloneApp: () => mocks.standalone,
  listPushSubscriptions: mocks.devices,
  setPushChannelPreference: mocks.setChannelPreference,
}))

describe('configuración de notificaciones push', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('Notification', { permission: 'default' })
    mocks.configured = true
    mocks.ios = false
    mocks.standalone = true
    mocks.supported = true
    mocks.current.mockResolvedValue(null)
    mocks.devices.mockResolvedValue([])
    mocks.activate.mockResolvedValue(undefined)
  })

  it('no solicita permiso hasta que el usuario pulsa activar', async () => {
    const user = userEvent.setup()
    render(<PushNotificationSettings />)
    const button = await screen.findByRole('button', { name: 'Activar notificaciones' })
    expect(mocks.activate).not.toHaveBeenCalled()
    await user.click(button)
    await waitFor(() => expect(mocks.activate).toHaveBeenCalledOnce())
  })

  it('explica la instalación requerida en iPhone antes de pedir permiso', async () => {
    mocks.ios = true
    mocks.standalone = false
    render(<PushNotificationSettings />)
    expect(await screen.findByText('En iPhone o iPad, instala Ordia primero')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Activar notificaciones' })).not.toBeInTheDocument()
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it('muestra un estado no bloqueante cuando falta la clave pública', async () => {
    mocks.configured = false
    render(<PushNotificationSettings />)
    expect(await screen.findByText('Falta configurar la clave pública VAPID. La aplicación financiera sigue disponible.')).toBeInTheDocument()
  })

  it('mantiene activos los recordatorios de gastos fijos al desactivar «Avisarme de movimientos bancarios»', async () => {
    const user = userEvent.setup()
    let subState = {
      id: 'sub-1',
      user_id: 'user-a',
      endpoint: 'https://push.ordia.test/sub-1',
      device_label: 'iPhone o iPad',
      active: true,
      notify_fixed_expenses: true,
      notify_bank_movements: true,
      disabled_at: null,
      disabled_reason: null,
      last_seen_at: '2026-11-01T12:00:00Z',
      last_success_at: null,
      created_at: '2026-11-01T12:00:00Z',
      updated_at: '2026-11-01T12:00:00Z',
    }
    mocks.current.mockResolvedValue({ endpoint: 'https://push.ordia.test/sub-1' })
    mocks.devices.mockImplementation(async () => [subState])
    mocks.setChannelPreference.mockImplementation(async (_id: string, _channel: string, enabled: boolean) => {
      subState = { ...subState, notify_bank_movements: enabled }
      return subState
    })

    render(<PushNotificationSettings />)

    // Ambos canales empiezan activos
    expect(await screen.findByText('Activadas')).toBeInTheDocument()
    const bankToggle = screen.getByRole('button', { name: 'Desactivar avisos bancarios' })
    expect(bankToggle).toHaveAttribute('aria-pressed', 'true')

    // Desactivar avisos bancarios NO debe cancelar la suscripción ni desactivar gastos fijos
    await user.click(bankToggle)
    await waitFor(() =>
      expect(mocks.setChannelPreference).toHaveBeenCalledWith('sub-1', 'bank_movements', false),
    )
    expect(mocks.deactivate).not.toHaveBeenCalled()
    expect(
      await screen.findByText(
        'Se desactivaron los avisos de movimientos bancarios. Los recordatorios de gastos fijos siguen activos.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Activadas')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Activar avisos bancarios' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
