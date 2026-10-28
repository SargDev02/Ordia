import { useState } from 'react'
import type { useCalendarProvider } from '../calendar/useCalendarProvider'
import type { CalendarProvider } from '../types/calendar'
import { PROVIDER_LABELS } from '../calendar/unified'
import { calendarError } from '../services/calendar'
import { googleCalendarError, submitGoogleAuthorization } from '../services/googleCalendar'
import { formatTaskInstant } from '../tasks/calculations'
import { CalendarPicker } from './CalendarPicker'
import { IcloudConnectDialog } from './IcloudConnectDialog'
import { FormDialog } from './FormDialog'
import { AuthNotice } from './AuthNotice'

const button = 'min-h-11 rounded-xl border border-[#d6e1d3] bg-white px-4 py-2 text-sm font-semibold text-[#315c49] disabled:opacity-50'
export function CalendarProviderPanel({ provider, calendar }: { provider: CalendarProvider; calendar: ReturnType<typeof useCalendarProvider> }) {
  const label = PROVIDER_LABELS[provider]
  const [connecting, setConnecting] = useState(false); const [picking, setPicking] = useState(false); const [disconnecting, setDisconnecting] = useState(false)
  const [actionError, setActionError] = useState('')
  const connected = calendar.connection?.status === 'connected'
  const hasConnection = calendar.connection && calendar.connection.status !== 'disconnected'
  const error = actionError || calendar.error || (provider === 'icloud' ? calendarError : googleCalendarError)(calendar.connection?.error_code ?? null)
  async function connectGoogle() {
    setActionError('')
    try { const response = await calendar.run('start'); if (response) submitGoogleAuthorization(response) }
    catch (caught) { setActionError(caught instanceof Error ? caught.message : 'No pudimos iniciar Google Calendar.') }
  }
  return <section aria-label={`Conexión ${label}`} className="min-w-0 rounded-[24px] border border-[#dce6d9] bg-white p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold text-[#315c49]">{label}</h2><span className="text-xs font-semibold text-[#66796f]">{calendar.loading ? 'Cargando…' : connected ? 'Conectado' : hasConnection ? 'Necesita reconexión' : 'Sin conectar'}</span></div>
    {calendar.ready === false && <p className="mt-3 text-sm leading-6 text-[#718279]">{provider === 'google' ? 'Google Calendar está pendiente de configurar en Google Cloud y en el servidor. iCloud sigue disponible.' : 'La conexión de iCloud no está disponible o necesita configuración del servidor.'}</p>}
    <div className="mt-4 flex flex-wrap gap-2"><button className={button} disabled={calendar.ready !== true || !!calendar.busy} onClick={() => provider === 'icloud' ? setConnecting(true) : void connectGoogle()} type="button">{provider === 'icloud' ? connected ? 'Reconectar iCloud' : 'Conectar iCloud' : connected ? 'Reconectar Google Calendar' : 'Conectar Google Calendar'}</button>
      {hasConnection && <><button className={button} disabled={!connected || !!calendar.busy} onClick={() => { setActionError(''); setPicking(true) }} type="button">Elegir calendarios de {label}</button><button className={button} disabled={!connected || !!calendar.busy} onClick={() => void calendar.run('discover').catch(() => undefined)} type="button">Actualizar lista de {label}</button><button className={button} disabled={!connected || !!calendar.busy || !calendar.calendars.some((source) => source.selected)} onClick={() => void calendar.refresh().catch(() => undefined)} type="button">Actualizar {label}</button><button className={button} disabled={calendar.busy === 'disconnect'} onClick={() => { setActionError(''); setDisconnecting(true) }} type="button">Desconectar {label}</button></>}
    </div>
    {error && <div className="mt-4"><AuthNotice tone="error">{error}</AuthNotice></div>}
    {provider === 'google' && <p className="mt-3 text-xs leading-5 text-[#718279]">Autoriza una cuenta Google independiente del acceso a Ordia. <a className="underline" href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">Revisar acceso en Google</a>.</p>}
    {hasConnection && <p className="mt-3 text-sm text-[#718279]">{calendar.calendars.filter((source) => source.selected).length} calendario(s) seleccionado(s).</p>}
    <p className="mt-3 text-xs leading-5 text-[#718279]" aria-live="polite">{calendar.window ? `Última sincronización de esta semana: ${formatTaskInstant(calendar.window.synced_at)} · Bogotá.` : 'Esta semana aún no tiene una copia sincronizada.'} {calendar.busy ? 'Hay una operación en curso.' : ''} {error || calendar.connection?.status === 'reconnect' ? 'La copia de este proveedor puede estar desactualizada.' : ''}</p>
    {connecting && <IcloudConnectDialog onClose={() => setConnecting(false)} onConnect={async (email, password) => { await calendar.run('connect', { email, password }) }} />}
    {picking && <CalendarPicker calendars={calendar.calendars} onClose={() => setPicking(false)} onSave={async (ids) => { await calendar.run('select', { ids }) }} />}
    {disconnecting && <FormDialog title={`Desconectar ${label}`} onClose={() => { if (calendar.busy !== 'disconnect') setDisconnecting(false) }}><div className="p-6 sm:p-8"><h2 className="text-2xl font-semibold text-[#173f31]">¿Desconectar {label}?</h2><p className="mt-4 leading-7 text-[#66796f]">Se eliminarán de Ordia las credenciales y copias de eventos de {label}. Se conservarán el otro proveedor, tus tareas, finanzas y los eventos originales.{provider === 'google' ? ' Ordia también intentará revocar la autorización en Google; si no se confirma, podrás retirarla desde tu cuenta Google.' : ' Después puedes revocar la contraseña específica en Apple Account → Inicio de sesión y seguridad.'}</p>{actionError && <AuthNotice tone="error">{actionError}</AuthNotice>}<div className="mt-6 flex flex-wrap justify-end gap-3"><button className={button} data-dialog-initial-focus disabled={calendar.busy === 'disconnect'} onClick={() => setDisconnecting(false)} type="button">Cancelar</button><button className={button} disabled={calendar.busy === 'disconnect'} onClick={async () => { try { await calendar.run('disconnect'); setDisconnecting(false) } catch (caught) { setActionError(caught instanceof Error ? caught.message : 'No pudimos desconectar.') } }} type="button">Confirmar desconexión</button></div></div></FormDialog>}
  </section>
}
