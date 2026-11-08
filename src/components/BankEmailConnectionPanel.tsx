import { useCallback, useEffect, useState } from 'react'
import {
  activatePushChannel,
  getCurrentBrowserSubscription,
  isIosDevice,
  isPushConfigured,
  isPushSupported,
  isStandaloneApp,
  listPushSubscriptions,
  setPushChannelPreference,
} from '../services/pushNotifications'
import type { BankEmailAlias } from '../types/finance'
import type { PushSubscriptionRecord } from '../types/notifications'

interface BankEmailConnectionPanelProps {
  isAvailable?: boolean
  alias: BankEmailAlias | null
  inboundDomainOverride?: string
  onEnsureOrReplaceAlias?: (replace?: boolean) => Promise<BankEmailAlias>
  onConfirmAlias?: (aliasId: string) => Promise<BankEmailAlias>
  onDisableAlias?: (aliasId: string) => Promise<BankEmailAlias>
}

function normalizeInboundDomain(raw: string | undefined): string {
  const cleaned = (raw ?? '').trim().toLowerCase().replace(/^@/, '')
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned) ? cleaned : ''
}

function formatBogotaInstant(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Intl.DateTimeFormat('es-CO', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/Bogota',
    }).format(new Date(iso))
  } catch {
    return iso.slice(0, 16)
  }
}

export function BankEmailConnectionPanel({
  isAvailable = true,
  alias,
  inboundDomainOverride,
  onEnsureOrReplaceAlias,
  onConfirmAlias,
  onDisableAlias,
}: BankEmailConnectionPanelProps) {
  const configuredDomain = normalizeInboundDomain(
    inboundDomainOverride ?? import.meta.env.VITE_BANK_INBOUND_EMAIL_DOMAIN,
  )
  const [expanded, setExpanded] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Estado de la preferencia push independiente «Avisarme de movimientos bancarios»
  const [pushSupported, setPushSupported] = useState(false)
  const [pushConfigured, setPushConfigured] = useState(false)
  const [pushIosNeedsInstall, setPushIosNeedsInstall] = useState(false)
  const [pushDenied, setPushDenied] = useState(false)
  const [currentDevice, setCurrentDevice] = useState<PushSubscriptionRecord | null>(null)
  const [isPushBusy, setIsPushBusy] = useState(false)
  const [pushFeedback, setPushFeedback] = useState('')
  const [pushError, setPushError] = useState('')

  const refreshPushState = useCallback(async () => {
    setPushError('')
    const configured = isPushConfigured()
    const supported = isPushSupported()
    const iosNeedsInstall = isIosDevice() && !isStandaloneApp()
    setPushConfigured(configured)
    setPushSupported(supported)
    setPushIosNeedsInstall(iosNeedsInstall)

    if (!configured || !supported || iosNeedsInstall) {
      setCurrentDevice(null)
      return
    }

    if (window.Notification.permission === 'denied') {
      setPushDenied(true)
      setCurrentDevice(null)
      return
    }
    setPushDenied(false)

    try {
      const [browserSub, devices] = await Promise.all([
        getCurrentBrowserSubscription(),
        listPushSubscriptions(),
      ])
      const endpoint = browserSub?.endpoint ?? ''
      const matched = endpoint
        ? devices.find((d) => d.active && d.endpoint === endpoint) ?? null
        : null
      setCurrentDevice(matched)
    } catch {
      setCurrentDevice(null)
    }
  }, [])

  useEffect(() => {
    if (!expanded) return
    // Sincronizar estado de suscripción del dispositivo al desplegar el panel
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    void refreshPushState()
  }, [expanded, refreshPushState])

  const stateKind: 'unconfigured' | 'pending_confirmation' | 'active' | 'disabled' = !alias
    ? 'unconfigured'
    : alias.status

  const stateBadge = (() => {
    if (!isAvailable) {
      return { label: 'Migración pendiente', className: 'bg-[#fbeeed] text-[#9a493e]' }
    }
    if (!configuredDomain && stateKind === 'unconfigured') {
      return { label: 'Sin configurar · Dominio pendiente', className: 'bg-[#f1eee4] text-[#796b3e]' }
    }
    if (stateKind === 'unconfigured') {
      return { label: 'Sin configurar', className: 'bg-[#eef3ec] text-[#52675d]' }
    }
    if (stateKind === 'pending_confirmation') {
      return {
        label: alias?.confirmation_received_at
          ? 'Pendiente de confirmación · Solicitud recibida'
          : 'Pendiente de confirmación',
        className: 'bg-[#fef3cd] text-[#856404]',
      }
    }
    if (stateKind === 'active') {
      return {
        label: alias?.first_notification_at
          ? 'Activo · Primer aviso recibido'
          : 'Activo · Dirección confirmada',
        className: 'bg-[#e5f2e4] text-[#347151]',
      }
    }
    return { label: 'Desactivado', className: 'bg-[#fbeeed] text-[#8b554d]' }
  })()

  const operationalAddress =
    configuredDomain && alias && alias.status !== 'disabled'
      ? `${alias.alias_local_part}@${configuredDomain}`
      : null

  const safeConfirmationUrl =
    alias?.confirmation_url &&
    /^https:\/\/(mail|isolated\.mail)\.google\.com\/mail\//.test(alias.confirmation_url)
      ? alias.confirmation_url
      : null

  async function handleGenerateOrReplace(replace: boolean) {
    if (!onEnsureOrReplaceAlias) return
    if (!configuredDomain) {
      setError('Configura primero el dominio de recepción entrante antes de generar una dirección operativa.')
      return
    }
    if (
      replace &&
      !window.confirm(
        '¿Reemplazar tu dirección privada actual? La dirección anterior dejará de aceptar avisos bancarios de inmediato y tendrás que actualizar el filtro en Gmail.',
      )
    ) {
      return
    }

    setIsBusy(true)
    setError('')
    setNotice('')
    try {
      await onEnsureOrReplaceAlias(replace)
      setNotice(
        replace
          ? 'Se generó una dirección nueva. La dirección anterior quedó desactivada de inmediato.'
          : 'Se generó tu dirección privada exclusiva. Añádela en Gmail siguiendo los pasos de abajo.',
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos generar la dirección.')
    } finally {
      setIsBusy(false)
    }
  }

  async function handleConfirm() {
    if (!alias || !onConfirmAlias) return
    setIsBusy(true)
    setError('')
    setNotice('')
    try {
      await onConfirmAlias(alias.id)
      setNotice(
        'Dirección marcada como confirmada. Cuando Gmail reenvíe el primer aviso de Bancolombia verás aquí la marca «Primer aviso recibido».',
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos confirmar la dirección.')
    } finally {
      setIsBusy(false)
    }
  }

  async function handleDisable() {
    if (!alias || !onDisableAlias) return
    if (
      !window.confirm(
        '¿Desactivar esta dirección de recepción? Dejará de aceptar avisos reenviados de inmediato.',
      )
    ) {
      return
    }
    setIsBusy(true)
    setError('')
    setNotice('')
    try {
      await onDisableAlias(alias.id)
      setNotice('La dirección quedó desactivada y ya no aceptará avisos entrantes.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos desactivar la dirección.')
    } finally {
      setIsBusy(false)
    }
  }

  async function copyText(value: string, label: string) {
    setError('')
    try {
      await navigator.clipboard.writeText(value)
      setNotice(`${label} copiado al portapapeles.`)
    } catch {
      setError(`No pudimos copiar automáticamente. Copia manualmente el valor mostrado.`)
    }
  }

  const bankPushEnabled = Boolean(currentDevice?.active && currentDevice.notify_bank_movements)

  async function handleToggleBankPush() {
    setIsPushBusy(true)
    setPushError('')
    setPushFeedback('')
    try {
      if (bankPushEnabled && currentDevice) {
        const updated = await setPushChannelPreference(currentDevice.id, 'bank_movements', false)
        setCurrentDevice(updated.active ? updated : null)
        setPushFeedback(
          (currentDevice.notify_fixed_expenses ?? true)
            ? 'Desactivaste los avisos bancarios en este dispositivo. Tus recordatorios de gastos fijos siguen activos.'
            : 'Desactivaste los avisos bancarios en este dispositivo.',
        )
      } else if (currentDevice) {
        const updated = await setPushChannelPreference(currentDevice.id, 'bank_movements', true)
        setCurrentDevice(updated)
        setPushFeedback('Activaste «Avisarme de movimientos bancarios» en este dispositivo.')
      } else {
        const created = await activatePushChannel('bank_movements')
        setCurrentDevice(created)
        setPushFeedback('Activaste «Avisarme de movimientos bancarios» en este dispositivo.')
      }
    } catch (caught) {
      setPushError(caught instanceof Error ? caught.message : 'No pudimos cambiar tu preferencia de avisos.')
      if ('Notification' in window && window.Notification.permission === 'denied') {
        setPushDenied(true)
      }
    } finally {
      setIsPushBusy(false)
    }
  }

  const gmailFilterQuery =
    'from:(alertasynotificaciones@an.bancolombia.com.co OR alertasynotificaciones@ayn.bancolombia.com.co OR alertasynotificaciones@bancolombia.com.co OR alertasynotificaciones@notificacionesbancolombia.com OR serviciopse@achcolombia.com.co)'

  return (
    <div className="mt-5 rounded-2xl border border-[#dce6d9] bg-[#f8faf6] p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[#173f31]">Conectar mi correo (reenvío selectivo desde Gmail)</h3>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${stateBadge.className}`}>
              {stateBadge.label}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[#66796f]">
            Recibe automáticamente tus avisos de Bancolombia y comprobantes PSE mediante un filtro de Gmail, sin dar acceso OAuth ni leer toda tu bandeja.
          </p>
        </div>
        <button
          aria-expanded={expanded}
          className="self-start rounded-xl border border-[#cfe0cc] bg-white px-3.5 py-2 text-xs font-semibold text-[#264a3c] hover:bg-[#edf3ea] sm:self-center"
          onClick={() => setExpanded((prev) => !prev)}
          type="button"
        >
          {expanded ? 'Ocultar configuración' : 'Conectar mi correo'}
        </button>
      </div>

      {expanded && (
        <div className="mt-4 space-y-4 border-t border-[#e2eae0] pt-4 text-sm text-[#395447]">
          {!isAvailable ? (
            <div role="status" className="rounded-xl border border-[#f0d4cf] bg-[#fdf5f3] p-3.5 text-xs text-[#8b463d]">
              Falta aplicar la migración de recepción automática por correo en la base de datos.
            </div>
          ) : !configuredDomain ? (
            <div role="status" className="rounded-xl border border-[#e6dec8] bg-[#fbf8ef] p-3.5 text-xs leading-5 text-[#6e5f34]">
              <p className="font-semibold">Proveedor y dominio de correo entrante pendientes de configurar</p>
              <p className="mt-1">
                Ordia no muestra una dirección operativa hasta que configures el dominio receptor autorizado en{' '}
                <code>VITE_BANK_INBOUND_EMAIL_DOMAIN</code> y el webhook <code>bank-email-webhook</code> (por ejemplo, el subdominio entrante gratuito de Resend Inbound o un subdominio propio con registro MX). Mientras tanto puedes seguir pegando tus avisos manualmente abajo.
              </p>
            </div>
          ) : (
            <>
              {error && (
                <div role="alert" className="rounded-xl border border-[#f5c6cb] bg-[#fdf2f2] p-3 text-xs text-[#9a493e]">
                  {error}
                </div>
              )}
              {notice && (
                <div role="status" className="rounded-xl border border-[#cce3d0] bg-[#eef7ef] p-3 text-xs text-[#2b6844]">
                  {notice}
                </div>
              )}

              {/* Estado: Sin configurar */}
              {stateKind === 'unconfigured' && (
                <div className="rounded-xl border border-[#d6e1d3] bg-white p-4">
                  <p className="text-xs leading-5 text-[#52675d]">
                    Genera una dirección privada y exclusiva para tu cuenta de Ordia. Solo aceptará correos autenticados de Bancolombia o PSE reenviados automáticamente por tu filtro de Gmail.
                  </p>
                  <button
                    className="mt-3 rounded-xl bg-[#173f31] px-4 py-2 text-xs font-semibold text-white hover:bg-[#24533f] disabled:opacity-50"
                    disabled={isBusy || !onEnsureOrReplaceAlias}
                    onClick={() => void handleGenerateOrReplace(false)}
                    type="button"
                  >
                    {isBusy ? 'Generando…' : 'Generar dirección privada'}
                  </button>
                </div>
              )}

              {/* Estado: Desactivado */}
              {stateKind === 'disabled' && alias && (
                <div className="rounded-xl border border-[#ead4cf] bg-[#fffaf9] p-4">
                  <p className="text-xs font-semibold text-[#8b554d]">
                    Recepción automática desactivada
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[#66796f]">
                    Tu dirección anterior quedó desactivada{alias.disabled_at ? ` (${formatBogotaInstant(alias.disabled_at)} · Bogotá)` : ''} y rechaza cualquier correo entrante. Si deseas volver a recibir avisos, genera una dirección nueva y actualiza tu filtro en Gmail.
                  </p>
                  <button
                    className="mt-3 rounded-xl bg-[#173f31] px-4 py-2 text-xs font-semibold text-white hover:bg-[#24533f] disabled:opacity-50"
                    disabled={isBusy || !onEnsureOrReplaceAlias}
                    onClick={() => void handleGenerateOrReplace(true)}
                    type="button"
                  >
                    {isBusy ? 'Generando…' : 'Generar nueva dirección'}
                  </button>
                </div>
              )}

              {/* Estados con dirección activa o pendiente de confirmación */}
              {(stateKind === 'pending_confirmation' || stateKind === 'active') && operationalAddress && alias && (
                <div className="space-y-4 rounded-xl border border-[#d6e1d3] bg-white p-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#557064]">
                      Tu dirección privada de recepción
                    </p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <code className="break-all rounded-lg bg-[#f4f7f1] px-3 py-2 text-xs font-semibold text-[#173f31]">
                        {operationalAddress}
                      </code>
                      <div className="flex flex-wrap gap-2">
                        <button
                          className="rounded-xl bg-[#edf3ea] px-3 py-2 text-xs font-semibold text-[#315c49] hover:bg-[#dce9d8]"
                          onClick={() => void copyText(operationalAddress, 'Dirección privada')}
                          type="button"
                        >
                          Copiar dirección
                        </button>
                        <button
                          className="rounded-xl border border-[#d6e1d3] px-3 py-2 text-xs font-semibold text-[#456356] hover:bg-[#f4f7f1] disabled:opacity-50"
                          disabled={isBusy}
                          onClick={() => void handleGenerateOrReplace(true)}
                          type="button"
                        >
                          Reemplazar
                        </button>
                        <button
                          className="rounded-xl border border-[#ddc9c4] bg-[#fff8f6] px-3 py-2 text-xs font-semibold text-[#8b554d] hover:bg-[#fbedea] disabled:opacity-50"
                          disabled={isBusy}
                          onClick={() => void handleDisable()}
                          type="button"
                        >
                          Desactivar
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Distinción explícita entre dirección confirmada y primer aviso recibido */}
                  {stateKind === 'active' && (
                    <div className="rounded-xl bg-[#f4f7f1] p-3 text-xs leading-5 text-[#456356]">
                      {alias.first_notification_at ? (
                        <p>
                          <span className="font-semibold text-[#173f31]">Primer aviso recibido:</span>{' '}
                          {formatBogotaInstant(alias.first_notification_at)} (Bogotá).
                          {alias.last_notification_at && alias.last_notification_at !== alias.first_notification_at
                            ? ` Último aviso recibido: ${formatBogotaInstant(alias.last_notification_at)}.`
                            : ''}
                        </p>
                      ) : (
                        <p>
                          <span className="font-semibold text-[#173f31]">Dirección confirmada en Ordia</span>
                          {alias.confirmed_at ? ` (${formatBogotaInstant(alias.confirmed_at)} · Bogotá)` : ''}. Todavía no se ha recibido el primer aviso bancario reenviado; asegúrate de crear el filtro selectivo en Gmail.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Paso de confirmación de Gmail */}
                  {stateKind === 'pending_confirmation' && (
                    <div className="rounded-xl border border-[#f0dfb4] bg-[#fffbeb] p-3.5 text-xs leading-5 text-[#6b5314]">
                      <p className="font-semibold">Confirmación de Gmail pendiente</p>
                      {!alias.confirmation_received_at ? (
                        <p className="mt-1">
                          Cuando añadas esta dirección en Gmail, Google enviará un mensaje de verificación a Ordia. Esta sección se actualizará automáticamente sin crear ningún movimiento bancario.
                        </p>
                      ) : (
                        <div className="mt-2 space-y-2.5">
                          <p>
                            Recibimos la solicitud de verificación de Gmail ({formatBogotaInstant(alias.confirmation_received_at)} · Bogotá). Complétala en Gmail y luego pulsa «Ya confirmé la dirección en Gmail»:
                          </p>
                          {alias.confirmation_code && (
                            <div className="flex flex-wrap items-center gap-2">
                              <span>Código de confirmación de Gmail:</span>
                              <code className="rounded bg-white px-2 py-1 font-bold text-[#173f31]">
                                {alias.confirmation_code}
                              </code>
                              <button
                                className="rounded-lg bg-white px-2.5 py-1 font-semibold text-[#315c49] underline"
                                onClick={() => void copyText(alias.confirmation_code!, 'Código de confirmación')}
                                type="button"
                              >
                                Copiar código
                              </button>
                            </div>
                          )}
                          {safeConfirmationUrl && (
                            <p>
                              O abre manualmente el enlace oficial de Google en una pestaña nueva:{' '}
                              <a
                                className="font-semibold text-[#2f664d] underline break-all"
                                href={safeConfirmationUrl}
                                rel="noopener noreferrer"
                                target="_blank"
                              >
                                Confirmar reenvío en Google Mail
                              </a>
                            </p>
                          )}
                          <div>
                            <button
                              className="rounded-xl bg-[#173f31] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#24533f] disabled:opacity-50"
                              disabled={isBusy || !onConfirmAlias}
                              onClick={() => void handleConfirm()}
                              type="button"
                            >
                              {isBusy ? 'Confirmando…' : 'Ya confirmé la dirección en Gmail'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Guía paso a paso de filtro selectivo (nunca reenvío global) */}
                  <details className="rounded-xl border border-[#e2eae0] bg-[#fbfcfa] p-3.5 text-xs leading-5 text-[#52675d]">
                    <summary className="cursor-pointer font-semibold text-[#264a3c]">
                      Cómo configurar en Gmail solo los avisos de Bancolombia y PSE
                    </summary>
                    <ol className="mt-2.5 list-decimal space-y-1.5 pl-5">
                      <li>
                        En Gmail (escritorio), abre <strong>Configuración → Ver todos los ajustes → Reenvío y correo POP/IMAP</strong> y pulsa <strong>Añadir una dirección de reenvío</strong> con tu dirección privada de arriba.
                      </li>
                      <li>
                        Completa la verificación de Google con el código o enlace que aparecerá aquí arriba.
                      </li>
                      <li>
                        <strong>Importante:</strong> en la sección general de Reenvío deja marcado{' '}
                        <strong>«Inhabilitar el reenvío»</strong>. <strong>No actives el reenvío general de todo tu correo.</strong>
                      </li>
                      <li>
                        Ve a <strong>Filtros y direcciones bloqueadas → Crear un filtro</strong>, pega esta búsqueda y elige <strong>Crear filtro → Reenviar a</strong> tu dirección privada:
                        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                          <code className="block flex-1 break-words rounded bg-white p-2 text-[11px] text-[#173f31]">
                            {gmailFilterQuery}
                          </code>
                          <button
                            className="self-start rounded-lg bg-[#edf3ea] px-2.5 py-1.5 font-semibold text-[#315c49]"
                            onClick={() => void copyText(gmailFilterQuery, 'Filtro para Gmail')}
                            type="button"
                          >
                            Copiar filtro
                          </button>
                        </div>
                      </li>
                    </ol>
                    <p className="mt-2 text-[11px] text-[#718279]">
                      Ordia verifica la firma del webhook, el remitente original y la autenticación DKIM/DMARC de Bancolombia o ACH Colombia. El remitente PSE admitido es exactamente serviciopse@achcolombia.com.co. Un reenvío manual con el botón «Reenviar» cambia el remitente a tu Gmail y se ignora por seguridad; para correos anteriores usa el recuadro de pegado manual.
                    </p>
                  </details>
                </div>
              )}
            </>
          )}

          {/* Preferencia independiente de notificación al celular */}
          <div className="rounded-xl border border-[#dce6d9] bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold text-[#173f31]">Avisarme de movimientos bancarios en este dispositivo</p>
                <p className="mt-1 text-xs leading-5 text-[#66796f]">
                  Muestra «Ordia · Movimiento por revisar» en la pantalla bloqueada sin exponer monto, comercio ni cuenta. Es independiente de los recordatorios de gastos fijos.
                </p>
              </div>
              {pushConfigured && pushSupported && !pushIosNeedsInstall && !pushDenied && (
                <button
                  aria-pressed={bankPushEnabled}
                  className={`shrink-0 rounded-xl px-3.5 py-2 text-xs font-semibold disabled:opacity-50 ${
                    bankPushEnabled
                      ? 'border border-[#ddc9c4] bg-[#fff8f6] text-[#8b554d]'
                      : 'bg-[#173f31] text-white'
                  }`}
                  disabled={isPushBusy}
                  onClick={() => void handleToggleBankPush()}
                  type="button"
                >
                  {isPushBusy
                    ? 'Actualizando…'
                    : bankPushEnabled
                      ? 'Desactivar avisos bancarios'
                      : 'Avisarme de movimientos bancarios'}
                </button>
              )}
            </div>
            {pushIosNeedsInstall && (
              <p className="mt-2 text-xs text-[#6e5f34]">
                En iPhone o iPad, añade primero Ordia a la pantalla de inicio desde Safari para activar avisos push.
              </p>
            )}
            {pushDenied && (
              <p className="mt-2 text-xs text-[#9a493e]">
                El permiso de notificaciones está bloqueado en este navegador o dispositivo.
              </p>
            )}
            {!pushConfigured && (
              <p className="mt-2 text-xs text-[#718279]">
                Falta configurar <code>VITE_VAPID_PUBLIC_KEY</code> para habilitar notificaciones push en este entorno.
              </p>
            )}
            {pushError && (
              <p role="alert" className="mt-2 text-xs text-[#9a493e]">
                {pushError}
              </p>
            )}
            {pushFeedback && (
              <p role="status" className="mt-2 text-xs text-[#2b6844]">
                {pushFeedback}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
