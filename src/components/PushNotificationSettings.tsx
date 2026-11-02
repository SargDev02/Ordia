import { useCallback, useEffect, useState } from 'react'
import { AuthNotice } from './AuthNotice'
import {
  activatePushChannel,
  activatePushNotifications,
  deactivatePushNotifications,
  getCurrentBrowserSubscription,
  isIosDevice,
  isPushConfigured,
  isPushSupported,
  isStandaloneApp,
  listPushSubscriptions,
  setPushChannelPreference,
} from '../services/pushNotifications'
import type { PushAvailability, PushSubscriptionRecord } from '../types/notifications'

export function PushNotificationSettings() {
  const [availability, setAvailability] = useState<PushAvailability>('checking')
  const [devices, setDevices] = useState<PushSubscriptionRecord[]>([])
  const [currentEndpoint, setCurrentEndpoint] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    setError('')
    if (!isPushConfigured()) return setAvailability('configuration-pending')
    if (!isPushSupported()) return setAvailability('unsupported')
    if (isIosDevice() && !isStandaloneApp()) return setAvailability('ios-install-required')
    if (window.Notification.permission === 'denied') return setAvailability('denied')

    try {
      const [browserSubscription, registeredDevices] = await Promise.all([
        getCurrentBrowserSubscription(),
        listPushSubscriptions(),
      ])
      const endpoint = browserSubscription?.endpoint ?? ''
      setCurrentEndpoint(endpoint)
      const activeDevices = registeredDevices.filter((device) => device.active)
      setDevices(activeDevices)
      const currentDevice = endpoint
        ? activeDevices.find((device) => device.endpoint === endpoint)
        : undefined
      const fixedEnabled = Boolean(currentDevice && (currentDevice.notify_fixed_expenses ?? true))
      setAvailability(fixedEnabled ? 'active' : 'inactive')
    } catch (caught) {
      setAvailability('inactive')
      setError(caught instanceof Error ? caught.message : 'No pudimos comprobar las notificaciones.')
    }
  }, [])

  // La comprobación del navegador y del registro remoto solo puede hacerse después del montaje.
  // oxlint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh() }, [refresh])

  const currentDevice = currentEndpoint
    ? devices.find((device) => device.endpoint === currentEndpoint) ?? null
    : null
  const bankAlertsEnabled = Boolean(currentDevice?.active && currentDevice.notify_bank_movements)

  async function activateFixedReminders() {
    setIsBusy(true); setError(''); setMessage('')
    try {
      await activatePushNotifications()
      setMessage('Los recordatorios de gastos fijos quedaron activados en este dispositivo.')
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos activar las notificaciones.')
      if ('Notification' in window && window.Notification.permission === 'denied') setAvailability('denied')
    } finally { setIsBusy(false) }
  }

  async function deactivateFixedReminders() {
    if (!currentDevice) return
    setIsBusy(true); setError(''); setMessage('')
    try {
      if (typeof setPushChannelPreference === 'function' && currentDevice.notify_bank_movements) {
        await setPushChannelPreference(currentDevice.id, 'fixed_expenses', false)
        setMessage('Se desactivaron los recordatorios de gastos fijos. Los avisos bancarios siguen activos en este dispositivo.')
      } else if (typeof setPushChannelPreference === 'function') {
        await setPushChannelPreference(currentDevice.id, 'fixed_expenses', false)
        setMessage('Las notificaciones quedaron desactivadas en este dispositivo.')
      } else {
        await deactivatePushNotifications(currentDevice.id)
        setMessage('Las notificaciones quedaron desactivadas en este dispositivo.')
      }
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos desactivar las notificaciones.')
      await refresh()
    } finally { setIsBusy(false) }
  }

  async function toggleBankMovementsPreference() {
    setIsBusy(true); setError(''); setMessage('')
    try {
      if (bankAlertsEnabled && currentDevice) {
        await setPushChannelPreference(currentDevice.id, 'bank_movements', false)
        setMessage(
          (currentDevice.notify_fixed_expenses ?? true)
            ? 'Se desactivaron los avisos de movimientos bancarios. Los recordatorios de gastos fijos siguen activos.'
            : 'Se desactivaron los avisos de movimientos bancarios en este dispositivo.',
        )
      } else if (currentDevice && typeof setPushChannelPreference === 'function') {
        await setPushChannelPreference(currentDevice.id, 'bank_movements', true)
        setMessage('Activaste «Avisarme de movimientos bancarios» en este dispositivo.')
      } else {
        await activatePushChannel('bank_movements')
        setMessage('Activaste «Avisarme de movimientos bancarios» en este dispositivo.')
      }
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos cambiar la preferencia de avisos bancarios.')
      if ('Notification' in window && window.Notification.permission === 'denied') setAvailability('denied')
    } finally { setIsBusy(false) }
  }

  const canConfigureChannels =
    availability === 'active' || availability === 'inactive'

  return (
    <section aria-labelledby="push-settings-title" className="mt-8 rounded-[24px] border border-[#dce6d9] bg-white p-5 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#4f8068]">Recordatorios por dispositivo</p>
          <h2 className="mt-2 text-xl font-semibold text-[#173f31]" id="push-settings-title">Notificaciones de pagos</h2>
          <p className="mt-2 text-sm leading-6 text-[#66796f]">Ordia puede avisarte un día antes, el día del vencimiento y una vez al día mientras siga vencido. La entrega depende del navegador, el sistema operativo y su servicio push.</p>
        </div>
        <PushStateBadge availability={availability} />
      </div>

      {availability === 'ios-install-required' && <div className="mt-5 rounded-2xl bg-[#f4f7f1] p-4 text-sm leading-6 text-[#52675d]"><p className="font-semibold">En iPhone o iPad, instala Ordia primero</p><ol className="mt-2 list-decimal space-y-1 pl-5"><li>Abre Ordia en Safari.</li><li>Pulsa Compartir y luego “Añadir a pantalla de inicio”.</li><li>Abre Ordia desde su icono y vuelve a pulsar “Activar notificaciones”.</li></ol></div>}
      {availability === 'configuration-pending' && <div className="mt-5"><AuthNotice tone="info">Falta configurar la clave pública VAPID. La aplicación financiera sigue disponible.</AuthNotice></div>}
      {availability === 'unsupported' && <div className="mt-5"><AuthNotice tone="info">Este navegador o entorno no ofrece Web Push. Comprueba que uses HTTPS o localhost y un navegador compatible.</AuthNotice></div>}
      {availability === 'denied' && <div className="mt-5"><AuthNotice tone="error">El permiso está bloqueado. Debes habilitar las notificaciones para Ordia desde la configuración del navegador o del dispositivo.</AuthNotice></div>}
      {error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}
      {message && <div className="mt-5"><AuthNotice tone="success">{message}</AuthNotice></div>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {(availability === 'inactive' || availability === 'denied') && <button className="rounded-xl bg-[#173f31] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60" disabled={isBusy || availability === 'denied'} onClick={() => void activateFixedReminders()} type="button">{isBusy ? 'Activando…' : 'Activar notificaciones'}</button>}
        {availability === 'active' && <button className="rounded-xl border border-[#ddc9c4] bg-[#fff8f6] px-4 py-2.5 text-sm font-semibold text-[#8b554d] disabled:opacity-60" disabled={isBusy} onClick={() => void deactivateFixedReminders()} type="button">{isBusy ? 'Desactivando…' : 'Desactivar en este dispositivo'}</button>}
        {availability === 'inactive' && <p className="text-sm text-[#718279]">El permiso se solicitará únicamente al pulsar el botón.</p>}
      </div>

      {canConfigureChannels && (
        <div className="mt-5 rounded-2xl border border-[#e2eae0] bg-[#f8faf6] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-[#173f31]">Avisarme de movimientos bancarios</p>
              <p className="mt-1 text-xs leading-5 text-[#66796f]">
                Preferencia independiente de tus gastos fijos. Envía un aviso discreto («Ordia · Movimiento por revisar») cuando llegue un pendiente automático nuevo.
              </p>
            </div>
            <button
              aria-pressed={bankAlertsEnabled}
              className={`shrink-0 rounded-xl px-3.5 py-2 text-xs font-semibold disabled:opacity-60 ${
                bankAlertsEnabled
                  ? 'border border-[#ddc9c4] bg-[#fff8f6] text-[#8b554d]'
                  : 'bg-[#edf3ea] text-[#315c49]'
              }`}
              disabled={isBusy}
              onClick={() => void toggleBankMovementsPreference()}
              type="button"
            >
              {bankAlertsEnabled ? 'Desactivar avisos bancarios' : 'Activar avisos bancarios'}
            </button>
          </div>
        </div>
      )}

      {devices.length > 0 && <details className="mt-5 rounded-2xl bg-[#f4f7f1] p-4"><summary className="cursor-pointer text-sm font-semibold text-[#52675d]">Dispositivos activos ({devices.length})</summary><ul className="mt-3 space-y-2">{devices.map((device) => <li className="flex flex-wrap items-center justify-between gap-2 text-sm text-[#66796f]" key={device.id}><span>{device.device_label}{device.endpoint === currentEndpoint ? ' · este dispositivo' : ''}</span><span>Registrado {device.created_at.slice(0, 10)}</span></li>)}</ul></details>}
      <p className="mt-4 text-xs leading-5 text-[#829188]">Al cerrar sesión, Ordia cancela la suscripción de este navegador para evitar avisos de la cuenta anterior en un dispositivo compartido.</p>
    </section>
  )
}

function PushStateBadge({ availability }: { availability: PushAvailability }) {
  const label = availability === 'active' ? 'Activadas' : availability === 'denied' ? 'Permiso denegado' : availability === 'unsupported' ? 'No compatible' : availability === 'configuration-pending' ? 'Configuración pendiente' : availability === 'ios-install-required' ? 'Instalación requerida' : availability === 'checking' ? 'Comprobando…' : 'Desactivadas'
  const color = availability === 'active' ? 'bg-[#e5f2e4] text-[#347151]' : availability === 'denied' ? 'bg-[#f8e7e3] text-[#94443a]' : 'bg-[#f1eee4] text-[#796b3e]'
  return <span aria-live="polite" className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${color}`}>{label}</span>
}
