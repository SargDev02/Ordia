import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PushNotificationSettings } from './PushNotificationSettings'

const mocks = vi.hoisted(() => ({
  activate: vi.fn(),
  current: vi.fn(),
  devices: vi.fn(),
  configured: true,
  ios: false,
  standalone: true,
  supported: true,
}))

vi.mock('../services/pushNotifications', () => ({
  activatePushNotifications: mocks.activate,
  deactivatePushNotifications: vi.fn(),
  getCurrentBrowserSubscription: mocks.current,
  isIosDevice: () => mocks.ios,
  isPushConfigured: () => mocks.configured,
  isPushSupported: () => mocks.supported,
  isStandaloneApp: () => mocks.standalone,
  listPushSubscriptions: mocks.devices,
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
})
