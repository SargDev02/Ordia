import { useMemo, useState, type FormEvent } from 'react'
import { formatCop, getCategoryLabel } from '../finance/calculations'
import {
  isTransactionCompatibleWithNotification,
  parseBancolombiaNotification,
  resolveKnownAccountId,
} from '../finance/bankNotificationParser'
import { TRANSACTION_KIND_LABELS } from '../finance/constants'
import type {
  BankCardAccountLink,
  BankEmailAlias,
  BankNotification,
  FinancialAccount,
  FinancialCategory,
  FinancialTransaction,
} from '../types/finance'
import { BankEmailConnectionPanel } from './BankEmailConnectionPanel'
import { CategoryPicker } from './CategoryPicker'

interface BankNotificationsInboxProps {
  isAvailable?: boolean
  emailAvailable?: boolean
  emailAlias?: BankEmailAlias | null
  inboundDomainOverride?: string
  notifications: BankNotification[]
  cardAccountLinks: BankCardAccountLink[]
  accounts: FinancialAccount[]
  categories: FinancialCategory[]
  transactions: FinancialTransaction[]
  onEnsureOrReplaceAlias?: (replace?: boolean) => Promise<BankEmailAlias>
  onConfirmAlias?: (aliasId: string) => Promise<BankEmailAlias>
  onDisableAlias?: (aliasId: string) => Promise<BankEmailAlias>
  onCreateNotification: (input: {
    bank_name?: string
    notification_type: 'transfer_received' | 'purchase' | 'transfer_sent'
    amount: number
    occurred_on: string
    occurred_time: string
    merchant?: string | null
    account_last_digits?: string | null
    card_last_digits?: string | null
    card_type?: 'debit' | 'credit' | null
    counterparty_name?: string | null
    counterparty_account_last_digits?: string | null
  }) => Promise<BankNotification>
  onConfirmTransaction: (
    notificationId: string,
    requestId: string,
    input: {
      kind: 'income' | 'expense'
      account_id: string
      category_id: string
      description: string | null
      occurred_on: string
      remember_link?: boolean
      identifier_type?: 'card' | 'account'
      last_digits?: string
    },
  ) => Promise<void>
  onConfirmTransfer: (
    notificationId: string,
    requestId: string,
    input: {
      account_id: string
      destination_account_id: string
      description: string | null
      occurred_on: string
      remember_link?: boolean
      identifier_type?: 'card' | 'account'
      last_digits?: string
    },
  ) => Promise<void>
  onLinkTransaction: (notificationId: string, transactionId: string) => Promise<void>
  onDismissNotification: (notificationId: string) => Promise<void>
}

type ResolutionMode = 'transaction' | 'transfer' | 'link' | 'dismiss'

export function BankNotificationsInbox({
  isAvailable = true,
  emailAvailable = true,
  emailAlias = null,
  inboundDomainOverride,
  notifications,
  cardAccountLinks,
  accounts,
  categories,
  transactions,
  onEnsureOrReplaceAlias,
  onConfirmAlias,
  onDisableAlias,
  onCreateNotification,
  onConfirmTransaction,
  onConfirmTransfer,
  onLinkTransaction,
  onDismissNotification,
}: BankNotificationsInboxProps) {
  const [pasteText, setPasteText] = useState('')
  const [pasteError, setPasteError] = useState('')
  const [isPasting, setIsPasting] = useState(false)
  const [activeNotification, setActiveNotification] = useState<BankNotification | null>(null)
  const [resolutionMode, setResolutionMode] = useState<ResolutionMode>('transaction')

  // Estado del formulario de resolución
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [selectedTransferOriginId, setSelectedTransferOriginId] = useState('')
  const [selectedTransferDestinationId, setSelectedTransferDestinationId] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState('')
  const [descriptionInput, setDescriptionInput] = useState('')
  const [rememberLink, setRememberLink] = useState(true)
  const [selectedExistingTransactionId, setSelectedExistingTransactionId] = useState('')
  const [actionError, setActionError] = useState('')
  const [isSubmittingAction, setIsSubmittingAction] = useState(false)

  const activeAccounts = useMemo(() => accounts.filter((acc) => !acc.archived_at), [accounts])
  const pendingNotifications = useMemo(
    () => notifications.filter((n) => n.status === 'pending'),
    [notifications],
  )

  const alreadyLinkedTransactionIds = useMemo(
    () =>
      new Set(
        notifications.flatMap((n) => (n.resolved_transaction_id ? [n.resolved_transaction_id] : [])),
      ),
    [notifications],
  )

  // Encontrar cuenta sugerida para formularios de creación (enlace explícito primero; coincidencia de nombre como ayuda visual)
  function findDefaultAccount(notification: BankNotification): string {
    const known = resolveKnownAccountId(notification, cardAccountLinks, accounts)
    if (known && activeAccounts.some((a) => a.id === known)) {
      return known
    }
    if (notification.account_last_digits) {
      const matched = activeAccounts.find((a) => a.name.includes(notification.account_last_digits!))
      if (matched) return matched.id
    }
    return activeAccounts[0]?.id ?? ''
  }

  function handleOpenReview(notification: BankNotification) {
    setActiveNotification(notification)
    setActionError('')
    const defaultAcc = findDefaultAccount(notification)
    const alternateAcc = activeAccounts.find((a) => a.id !== defaultAcc)?.id ?? ''

    setSelectedAccountId(defaultAcc)
    if (notification.notification_type === 'transfer_received') {
      // En una transferencia recibida, la cuenta del aviso es el destino
      setSelectedTransferDestinationId(defaultAcc)
      setSelectedTransferOriginId(alternateAcc)
    } else {
      // En una transferencia enviada, la cuenta del aviso es el origen
      setSelectedTransferOriginId(defaultAcc)
      setSelectedTransferDestinationId(alternateAcc)
    }

    const isIncome = notification.notification_type === 'transfer_received'
    const defaultKind = isIncome ? 'income' : 'expense'
    const defaultCat = categories.find((c) => c.kind === defaultKind && !c.archived_at)?.id ?? ''
    setSelectedCategoryId(defaultCat)

    const initialDesc =
      notification.merchant ||
      (notification.notification_type === 'purchase'
        ? 'Compra con tarjeta'
        : notification.notification_type === 'transfer_received'
          ? notification.counterparty_name
            ? `Transferencia de ${notification.counterparty_name}`
            : 'Transferencia recibida'
          : 'Transferencia enviada')
    setDescriptionInput(initialDesc)
    setRememberLink(true)
    setSelectedExistingTransactionId('')
    setResolutionMode('transaction')
  }

  function handleCloseReview() {
    if (isSubmittingAction) return
    setActiveNotification(null)
    setActionError('')
  }

  async function handlePasteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPasteError('')

    if (!isAvailable) {
      setPasteError(
        'La bandeja «Movimientos por revisar» no está disponible todavía porque falta instalar su migración en la base de datos. No se guardó ningún pendiente.',
      )
      return
    }

    const result = parseBancolombiaNotification(pasteText)
    if (!result.success) {
      setPasteError(result.error)
      return
    }

    setIsPasting(true)
    try {
      const created = await onCreateNotification(result.data)
      if (!created || typeof created.id !== 'string' || !created.id) {
        throw new Error('No recibimos confirmación del servidor. No se guardó ningún pendiente.')
      }
      setPasteText('')
      handleOpenReview(created)
    } catch (caught) {
      setPasteError(caught instanceof Error ? caught.message : 'No pudimos registrar el aviso bancario.')
    } finally {
      setIsPasting(false)
    }
  }

  async function handleConfirmTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeNotification) return
    setActionError('')

    const kind = activeNotification.notification_type === 'transfer_received' ? 'income' : 'expense'
    if (!selectedAccountId) {
      setActionError('Selecciona la cuenta para registrar el movimiento.')
      return
    }
    if (!selectedCategoryId) {
      setActionError('Selecciona una categoría activa.')
      return
    }

    setIsSubmittingAction(true)
    try {
      const requestId = crypto.randomUUID()
      const identifierType = activeNotification.card_last_digits
        ? 'card'
        : activeNotification.account_last_digits
          ? 'account'
          : undefined
      const lastDigits = activeNotification.card_last_digits || activeNotification.account_last_digits || undefined

      await onConfirmTransaction(activeNotification.id, requestId, {
        account_id: selectedAccountId,
        category_id: selectedCategoryId,
        description: descriptionInput.trim() || null,
        identifier_type: identifierType,
        kind,
        last_digits: lastDigits,
        occurred_on: activeNotification.occurred_on,
        remember_link: rememberLink && Boolean(identifierType && lastDigits),
      })
      handleCloseReview()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'No pudimos registrar el movimiento.')
    } finally {
      setIsSubmittingAction(false)
    }
  }

  async function handleConfirmTransfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeNotification) return
    setActionError('')

    if (!selectedTransferOriginId) {
      setActionError('Selecciona la cuenta de origen.')
      return
    }
    if (!selectedTransferDestinationId) {
      setActionError('Selecciona la cuenta de destino.')
      return
    }
    if (selectedTransferOriginId === selectedTransferDestinationId) {
      setActionError('La cuenta de origen y de destino deben ser diferentes.')
      return
    }

    setIsSubmittingAction(true)
    try {
      const requestId = crypto.randomUUID()
      const identifierType = activeNotification.account_last_digits ? 'account' : undefined
      const lastDigits = activeNotification.account_last_digits || undefined

      await onConfirmTransfer(activeNotification.id, requestId, {
        account_id: selectedTransferOriginId,
        description: descriptionInput.trim() || 'Transferencia entre mis cuentas',
        destination_account_id: selectedTransferDestinationId,
        identifier_type: identifierType,
        last_digits: lastDigits,
        occurred_on: activeNotification.occurred_on,
        remember_link: rememberLink && Boolean(identifierType && lastDigits),
      })
      handleCloseReview()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'No pudimos registrar la transferencia.')
    } finally {
      setIsSubmittingAction(false)
    }
  }

  // Cuenta conocida explícitamente por enlace guardado para validar «Ya lo registré» igual que en el servidor
  const knownAccountIdForActive = useMemo(() => {
    if (!activeNotification) return null
    return resolveKnownAccountId(activeNotification, cardAccountLinks, accounts)
  }, [activeNotification, cardAccountLinks, accounts])

  // Movimientos compatibles para «Ya lo registré»: propietario, vigente, importe exacto, tipo, sentido y cuenta conocida
  const compatibleTransactions = useMemo(() => {
    if (!activeNotification) return []
    return transactions
      .filter((tx) => {
        if (alreadyLinkedTransactionIds.has(tx.id)) return false
        return isTransactionCompatibleWithNotification(tx, activeNotification, knownAccountIdForActive)
      })
      .sort((a, b) => {
        const aSameDay = a.occurred_on === activeNotification.occurred_on ? 0 : 1
        const bSameDay = b.occurred_on === activeNotification.occurred_on ? 0 : 1
        if (aSameDay !== bSameDay) return aSameDay - bSameDay
        return b.occurred_on.localeCompare(a.occurred_on)
      })
  }, [activeNotification, alreadyLinkedTransactionIds, knownAccountIdForActive, transactions])

  async function handleLinkExisting(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeNotification) return
    setActionError('')

    if (!selectedExistingTransactionId) {
      setActionError('Selecciona el movimiento registrado que corresponde a este aviso.')
      return
    }

    const selectedTx = compatibleTransactions.find((tx) => tx.id === selectedExistingTransactionId)
    if (!selectedTx) {
      setActionError(
        'El movimiento seleccionado ya no es elegible (verifica propietario, vigencia, importe exacto, tipo, sentido y cuenta).',
      )
      return
    }

    setIsSubmittingAction(true)
    try {
      await onLinkTransaction(activeNotification.id, selectedTx.id)
      handleCloseReview()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'No pudimos vincular el aviso.')
    } finally {
      setIsSubmittingAction(false)
    }
  }

  async function handleDismiss() {
    if (!activeNotification) return
    setIsSubmittingAction(true)
    try {
      await onDismissNotification(activeNotification.id)
      handleCloseReview()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'No pudimos descartar el aviso.')
    } finally {
      setIsSubmittingAction(false)
    }
  }

  const accountNamesMap = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts],
  )

  const activeKind = activeNotification
    ? activeNotification.notification_type === 'transfer_received'
      ? 'income'
      : 'expense'
    : 'expense'
  const categoryOptions = useMemo(() => {
    return categories
      .filter((c) => c.kind === activeKind && !c.archived_at)
      .sort((a, b) => getCategoryLabel(a.id, categories).localeCompare(getCategoryLabel(b.id, categories), 'es'))
  }, [categories, activeKind])

  return (
    <section
      aria-label="Bandeja de avisos bancarios por revisar"
      className="mt-8 rounded-[24px] border border-[#dce6d9] bg-white p-5 sm:p-7"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-[-0.03em] text-[#173f31] sm:text-2xl">
              Movimientos por revisar
            </h2>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                !isAvailable
                  ? 'bg-[#fbeeed] text-[#9a493e]'
                  : pendingNotifications.length > 0
                    ? 'bg-[#fef3cd] text-[#856404]'
                    : 'bg-[#edf5e8] text-[#4f8068]'
              }`}
            >
              {!isAvailable
                ? 'Bandeja no disponible'
                : pendingNotifications.length === 0
                  ? 'Sin pendientes'
                  : `${pendingNotifications.length} por revisar`}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-[#66796f]">
            Pega una notificación o SMS de Bancolombia para revisarla y convertirla en movimiento real. No cambia saldos hasta que lo confirmes.
          </p>
        </div>
      </div>

      {!isAvailable ? (
        <div
          role="status"
          className="mt-5 rounded-2xl border border-[#f0d4cf] bg-[#fdf5f3] p-5 text-sm leading-6 text-[#8b463d]"
        >
          <p className="font-semibold">Bandeja bancaria no disponible en este entorno</p>
          <p className="mt-1 text-xs text-[#9a493e]">
            Falta aplicar la migración de base de datos de «Movimientos por revisar». Este estado es distinto de tener cero pendientes: mientras no esté instalada, no se pueden guardar ni consultar avisos bancarios.
          </p>
        </div>
      ) : (
        <>
          <BankEmailConnectionPanel
            alias={emailAlias}
            inboundDomainOverride={inboundDomainOverride}
            isAvailable={emailAvailable}
            onConfirmAlias={onConfirmAlias}
            onDisableAlias={onDisableAlias}
            onEnsureOrReplaceAlias={onEnsureOrReplaceAlias}
          />

          {/* Formulario para pegar texto de aviso */}
          <form onSubmit={handlePasteSubmit} className="mt-5 rounded-2xl border border-[#e2eae0] bg-[#f8faf6] p-4">
            <label
              htmlFor="bancolombia-paste-input"
              className="block text-xs font-semibold uppercase tracking-[0.12em] text-[#557064]"
            >
              Pegar texto de aviso Bancolombia
            </label>
            <textarea
              id="bancolombia-paste-input"
              aria-label="Texto de la notificación bancaria"
              rows={3}
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value)
                if (pasteError) setPasteError('')
              }}
              disabled={isPasting}
              placeholder="Ej: Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17."
              className="mt-2 w-full rounded-xl border border-[#d3dfd1] bg-white p-3 text-sm text-[#173f31] placeholder-[#95a59c] focus:border-[#2f664d] focus:outline-none focus:ring-1 focus:ring-[#2f664d]"
            />
            {pasteError && (
              <div
                role="alert"
                className="mt-2 rounded-xl border border-[#f5c6cb] bg-[#fdf2f2] p-3 text-xs text-[#9a493e]"
              >
                {pasteError}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-[#829188]">
                Solo se guardan los datos exactos en pesos enteros. Nunca se almacena el mensaje completo ni se redondean centavos.
              </p>
              <button
                type="submit"
                disabled={!pasteText.trim() || isPasting}
                className="rounded-xl bg-[#173f31] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#255241] disabled:opacity-50"
              >
                {isPasting ? 'Revisando…' : 'Revisar aviso'}
              </button>
            </div>
          </form>

          {/* Lista de pendientes */}
          <div className="mt-6">
            {pendingNotifications.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#dce6d9] p-6 text-center text-sm text-[#718279]">
                No tienes avisos bancarios pendientes por revisar. Pega uno arriba para comenzar.
              </div>
            ) : (
              <div className="space-y-3">
                {pendingNotifications.map((notification) => {
                  const knownAccountForItem = resolveKnownAccountId(
                    notification,
                    cardAccountLinks,
                    accounts,
                  )
                  const hasMatchingNotification = notifications.some(
                    (other) =>
                      other.id !== notification.id &&
                      other.status !== 'dismissed' &&
                      other.amount === notification.amount &&
                      other.occurred_on === notification.occurred_on,
                  )
                  const hasMatchingUnlinkedTransaction = transactions.some(
                    (tx) =>
                      !alreadyLinkedTransactionIds.has(tx.id) &&
                      tx.occurred_on === notification.occurred_on &&
                      isTransactionCompatibleWithNotification(tx, notification, knownAccountForItem),
                  )
                  const isPossibleDuplicate =
                    hasMatchingNotification || hasMatchingUnlinkedTransaction

                  const isPurchase = notification.notification_type === 'purchase'
                  const isTransferReceived = notification.notification_type === 'transfer_received'
                  const typeLabel = isPurchase
                    ? 'Compra con tarjeta'
                    : isTransferReceived
                      ? 'Transferencia recibida'
                      : 'Transferencia enviada'
                  const typeColor = isTransferReceived
                    ? 'bg-[#e8f5ec] text-[#2f7650]'
                    : 'bg-[#fbeeed] text-[#9a493e]'

                  return (
                    <article
                      key={notification.id}
                      className="flex flex-col gap-3 rounded-2xl border border-[#dce6d9] bg-white p-4 transition hover:border-[#a8c2b5] sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${typeColor}`}>
                            {typeLabel}
                          </span>
                          {notification.source_channel === 'gmail' && (
                            <span className="rounded-md bg-[#eef4fb] px-2 py-0.5 text-xs font-medium text-[#2c587c]">
                              Correo reenviado
                            </span>
                          )}
                          <span className="text-xs text-[#718279]">
                            {notification.occurred_on} a las {notification.occurred_time}
                          </span>
                          {isPossibleDuplicate && (
                            <span
                              className="rounded-md bg-[#fff3cd] px-2 py-0.5 text-xs font-medium text-[#856404]"
                              title="Coincide en fecha e importe con otro aviso o movimiento registrado"
                            >
                              Posible coincidencia
                            </span>
                          )}
                        </div>

                        <div className="mt-2 flex items-baseline gap-2">
                          <p className="text-xl font-semibold tracking-[-0.03em] text-[#173f31]">
                            {formatCop(notification.amount)}
                          </p>
                          {notification.merchant && (
                            <p className="truncate text-sm font-medium text-[#456356]">
                              en {notification.merchant}
                            </p>
                          )}
                        </div>

                        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-[#829188]">
                          {notification.card_last_digits && (
                            <span>
                              {notification.card_type === 'debit' ? 'T.Débito' : 'Tarjeta'} *{notification.card_last_digits}
                            </span>
                          )}
                          {notification.account_last_digits && (
                            <span>Cuenta *{notification.account_last_digits}</span>
                          )}
                          {notification.counterparty_name && (
                            <span>De: {notification.counterparty_name}</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleOpenReview(notification)}
                          className="rounded-xl bg-[#edf3ea] px-3.5 py-2 text-sm font-semibold text-[#315c49] hover:bg-[#dce9d8]"
                        >
                          Revisar
                        </button>
                        <button
                          type="button"
                          aria-label={`Descartar aviso de ${formatCop(notification.amount)}`}
                          onClick={async () => {
                            if (window.confirm('¿Descartar este aviso bancario pendiente?')) {
                              await onDismissNotification(notification.id)
                            }
                          }}
                          className="rounded-xl px-2.5 py-2 text-xs font-semibold text-[#8b554d] hover:bg-[#fbedea]"
                        >
                          Descartar
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Panel / Diálogo de Revisión y Resolución */}
      {activeNotification && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="review-dialog-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation()
              handleCloseReview()
            }
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl sm:p-8">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">
                  Revisar aviso bancario
                </p>
                <h3 id="review-dialog-title" className="mt-1 text-2xl font-semibold text-[#173f31]">
                  {formatCop(activeNotification.amount)}
                </h3>
              </div>
              <button
                type="button"
                onClick={handleCloseReview}
                disabled={isSubmittingAction}
                className="text-sm font-semibold text-[#66796f] hover:text-[#173f31]"
              >
                Cerrar
              </button>
            </div>

            {/* Resumen de datos extraídos */}
            <div className="mt-4 space-y-1 rounded-xl bg-[#f4f7f1] p-3.5 text-xs text-[#52675d]">
              <p>
                <span className="font-semibold">Fecha:</span> {activeNotification.occurred_on} a las {activeNotification.occurred_time} (America/Bogota)
              </p>
              {activeNotification.merchant && (
                <p>
                  <span className="font-semibold">Comercio:</span> {activeNotification.merchant}
                </p>
              )}
              {activeNotification.card_last_digits && (
                <p>
                  <span className="font-semibold">Tarjeta:</span> {activeNotification.card_type === 'debit' ? 'Débito' : activeNotification.card_type === 'credit' ? 'Crédito' : ' Bancaria'} terminada en {activeNotification.card_last_digits}
                </p>
              )}
              {activeNotification.account_last_digits && (
                <p>
                  <span className="font-semibold">Cuenta:</span> Terminada en {activeNotification.account_last_digits}
                </p>
              )}
              {activeNotification.counterparty_name ? (
                <p>
                  <span className="font-semibold">Remitente:</span> {activeNotification.counterparty_name}
                </p>
              ) : (
                <p className="text-[#829188]">
                  <span className="font-semibold">Remitente / Destino:</span> No especificado en el aviso
                </p>
              )}
            </div>

            {actionError && (
              <div role="alert" className="mt-4 rounded-xl border border-[#f5c6cb] bg-[#fdf2f2] p-3 text-xs text-[#9a493e]">
                {actionError}
              </div>
            )}

            {/* Modos de acción según tipo de aviso */}
            <div className="mt-5 flex flex-wrap gap-2 border-b border-[#e5ebe2] pb-4">
              {activeNotification.notification_type === 'transfer_received' ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setResolutionMode('transaction'); setActionError('') }}
                    className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                      resolutionMode === 'transaction' ? 'bg-[#173f31] text-white' : 'bg-[#edf3ea] text-[#315c49]'
                    }`}
                  >
                    Registrar ingreso
                  </button>
                  <button
                    type="button"
                    onClick={() => { setResolutionMode('transfer'); setActionError('') }}
                    className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                      resolutionMode === 'transfer' ? 'bg-[#173f31] text-white' : 'bg-[#edf3ea] text-[#315c49]'
                    }`}
                  >
                    Transferencia entre mis cuentas
                  </button>
                </>
              ) : activeNotification.notification_type === 'transfer_sent' ? (
                <>
                  <button
                    type="button"
                    onClick={() => { setResolutionMode('transaction'); setActionError('') }}
                    className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                      resolutionMode === 'transaction' ? 'bg-[#173f31] text-white' : 'bg-[#edf3ea] text-[#315c49]'
                    }`}
                  >
                    Registrar gasto
                  </button>
                  <button
                    type="button"
                    onClick={() => { setResolutionMode('transfer'); setActionError('') }}
                    className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                      resolutionMode === 'transfer' ? 'bg-[#173f31] text-white' : 'bg-[#edf3ea] text-[#315c49]'
                    }`}
                  >
                    Transferencia entre mis cuentas
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => { setResolutionMode('transaction'); setActionError('') }}
                  className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                    resolutionMode === 'transaction' ? 'bg-[#173f31] text-white' : 'bg-[#edf3ea] text-[#315c49]'
                  }`}
                >
                  Registrar gasto
                </button>
              )}

              <button
                type="button"
                onClick={() => { setResolutionMode('link'); setActionError('') }}
                className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                  resolutionMode === 'link' ? 'bg-[#173f31] text-white' : 'bg-[#edf3ea] text-[#315c49]'
                }`}
              >
                Ya lo registré
              </button>

              <button
                type="button"
                onClick={() => { setResolutionMode('dismiss'); setActionError('') }}
                className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                  resolutionMode === 'dismiss' ? 'bg-[#9a493e] text-white' : 'bg-[#fbedea] text-[#8b554d]'
                }`}
              >
                Descartar
              </button>
            </div>

            {/* 1. MODO: REGISTRAR COMO GASTO O INGRESO */}
            {resolutionMode === 'transaction' && (
              <form onSubmit={handleConfirmTransaction} className="mt-4 space-y-4">
                <div>
                  <label htmlFor="review-account" className="block text-xs font-semibold text-[#264a3c]">
                    Cuenta en Ordia
                  </label>
                  <select
                    id="review-account"
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    disabled={isSubmittingAction}
                    className="mt-1.5 w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-2.5 text-sm"
                  >
                    <option value="">Selecciona una cuenta</option>
                    {activeAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>

                {(activeNotification.card_last_digits || activeNotification.account_last_digits) && (
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-[#52675d]">
                    <input
                      type="checkbox"
                      checked={rememberLink}
                      onChange={(e) => setRememberLink(e.target.checked)}
                      disabled={isSubmittingAction}
                      className="rounded"
                    />
                    <span>
                      {activeNotification.card_last_digits
                        ? `Recordar que la tarjeta *${activeNotification.card_last_digits} pertenece a esta cuenta`
                        : `Recordar que la cuenta bancaria *${activeNotification.account_last_digits} corresponde a esta cuenta`}
                    </span>
                  </label>
                )}

                <div>
                  <label htmlFor="review-description" className="block text-xs font-semibold text-[#264a3c]">
                    Descripción
                  </label>
                  <input
                    id="review-description"
                    type="text"
                    value={descriptionInput}
                    onChange={(e) => setDescriptionInput(e.target.value)}
                    disabled={isSubmittingAction}
                    className="mt-1.5 w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-2 text-sm"
                  />
                </div>

                <div>
                  <CategoryPicker
                    categories={categories}
                    disabled={isSubmittingAction}
                    id="review-category"
                    key={activeKind}
                    onChange={(id) => setSelectedCategoryId(id)}
                    options={categoryOptions}
                    value={selectedCategoryId}
                  />
                </div>

                <div className="mt-6 flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleCloseReview}
                    disabled={isSubmittingAction}
                    className="rounded-xl px-4 py-2 text-sm font-semibold text-[#66796f]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmittingAction || !selectedAccountId || !selectedCategoryId}
                    className="rounded-xl bg-[#173f31] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#24533f] disabled:opacity-50"
                  >
                    {isSubmittingAction ? 'Registrando…' : 'Confirmar y registrar'}
                  </button>
                </div>
              </form>
            )}

            {/* 2. MODO: TRANSFERENCIA ENTRE CUENTAS PROPIAS */}
            {resolutionMode === 'transfer' && (
              <form onSubmit={handleConfirmTransfer} className="mt-4 space-y-4">
                <div>
                  <label htmlFor="review-transfer-origin" className="block text-xs font-semibold text-[#264a3c]">
                    Cuenta de origen
                  </label>
                  <select
                    id="review-transfer-origin"
                    value={selectedTransferOriginId}
                    onChange={(e) => setSelectedTransferOriginId(e.target.value)}
                    disabled={isSubmittingAction}
                    className="mt-1.5 w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-2.5 text-sm"
                  >
                    <option value="">Selecciona origen</option>
                    {activeAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="review-transfer-destination" className="block text-xs font-semibold text-[#264a3c]">
                    Cuenta de destino
                  </label>
                  <select
                    id="review-transfer-destination"
                    value={selectedTransferDestinationId}
                    onChange={(e) => setSelectedTransferDestinationId(e.target.value)}
                    disabled={isSubmittingAction}
                    className="mt-1.5 w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-2.5 text-sm"
                  >
                    <option value="">Selecciona destino</option>
                    {activeAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </select>
                </div>

                {activeNotification.account_last_digits && (
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-[#52675d]">
                    <input
                      type="checkbox"
                      checked={rememberLink}
                      onChange={(e) => setRememberLink(e.target.checked)}
                      disabled={isSubmittingAction}
                      className="rounded"
                    />
                    <span>
                      {activeNotification.notification_type === 'transfer_received'
                        ? `Recordar que la cuenta *${activeNotification.account_last_digits} corresponde a la cuenta de destino`
                        : `Recordar que la cuenta *${activeNotification.account_last_digits} corresponde a la cuenta de origen`}
                    </span>
                  </label>
                )}

                <div>
                  <label htmlFor="review-transfer-desc" className="block text-xs font-semibold text-[#264a3c]">
                    Descripción
                  </label>
                  <input
                    id="review-transfer-desc"
                    type="text"
                    value={descriptionInput}
                    onChange={(e) => setDescriptionInput(e.target.value)}
                    disabled={isSubmittingAction}
                    className="mt-1.5 w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-2 text-sm"
                  />
                </div>

                <div className="mt-6 flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleCloseReview}
                    disabled={isSubmittingAction}
                    className="rounded-xl px-4 py-2 text-sm font-semibold text-[#66796f]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={
                      isSubmittingAction ||
                      !selectedTransferOriginId ||
                      !selectedTransferDestinationId ||
                      selectedTransferOriginId === selectedTransferDestinationId
                    }
                    className="rounded-xl bg-[#173f31] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#24533f] disabled:opacity-50"
                  >
                    {isSubmittingAction ? 'Registrando…' : 'Registrar transferencia'}
                  </button>
                </div>
              </form>
            )}

            {/* 3. MODO: YA LO REGISTRÉ (VINCULAR A MOVIMIENTO EXISTENTE) */}
            {resolutionMode === 'link' && (
              <form onSubmit={handleLinkExisting} className="mt-4 space-y-4">
                <p className="text-xs text-[#66796f]">
                  Selecciona el movimiento vigente que ya habías registrado para este aviso (mismo importe exacto, tipo, sentido
                  {knownAccountIdForActive ? ` y cuenta ${accountNamesMap.get(knownAccountIdForActive) ?? 'asociada'}` : ''}
                  ). Se marcará como revisado sin crear duplicados ni alterar saldos.
                </p>

                {compatibleTransactions.length > 0 ? (
                  <div className="max-h-60 space-y-2 overflow-y-auto rounded-xl border border-[#d6e1d3] p-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-[#789086]">
                      {compatibleTransactions.length === 1
                        ? `1 movimiento compatible (${formatCop(activeNotification.amount)}):`
                        : `${compatibleTransactions.length} movimientos compatibles (${formatCop(activeNotification.amount)}) · elige cuál corresponde:`}
                    </p>
                    {compatibleTransactions.map((tx) => {
                      const accountDetail =
                        tx.kind === 'transfer'
                          ? `${accountNamesMap.get(tx.account_id) ?? 'Cuenta'} → ${accountNamesMap.get(tx.destination_account_id ?? '') ?? 'Cuenta'}`
                          : `Cuenta: ${accountNamesMap.get(tx.account_id) ?? 'Cuenta'}`

                      return (
                        <label
                          key={tx.id}
                          className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 text-xs transition ${
                            selectedExistingTransactionId === tx.id
                              ? 'border-[#2f664d] bg-[#f4f7f1]'
                              : 'border-transparent hover:bg-[#f8faf6]'
                          }`}
                        >
                          <input
                            type="radio"
                            name="existing-tx"
                            value={tx.id}
                            checked={selectedExistingTransactionId === tx.id}
                            onChange={() => setSelectedExistingTransactionId(tx.id)}
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded bg-[#edf3ea] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#315c49]">
                                {TRANSACTION_KIND_LABELS[tx.kind]}
                              </span>
                              <p className="font-semibold text-[#173f31]">
                                {tx.description || getCategoryLabel(tx.category_id, categories)}
                              </p>
                            </div>
                            <p className="mt-0.5 text-[#718279]">
                              {tx.occurred_on} · {accountDetail}
                            </p>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                ) : (
                  <div className="rounded-xl border border-[#e2eae0] bg-[#f8faf6] p-4 text-xs text-[#718279]">
                    No se encontraron movimientos vigentes compatibles con el importe exacto de {formatCop(activeNotification.amount)}, el sentido del aviso
                    {knownAccountIdForActive ? ` y la cuenta asociada (${accountNamesMap.get(knownAccountIdForActive) ?? 'cuenta'})` : ''}.
                    Puedes registrarlo con las opciones superiores.
                  </div>
                )}

                <div className="mt-6 flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleCloseReview}
                    disabled={isSubmittingAction}
                    className="rounded-xl px-4 py-2 text-sm font-semibold text-[#66796f]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="submit"
                    disabled={isSubmittingAction || !selectedExistingTransactionId}
                    className="rounded-xl bg-[#173f31] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#24533f] disabled:opacity-50"
                  >
                    {isSubmittingAction ? 'Vinculando…' : 'Vincular a este movimiento'}
                  </button>
                </div>
              </form>
            )}

            {/* 4. MODO: DESCARTAR AVISO */}
            {resolutionMode === 'dismiss' && (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-[#718279]">
                  ¿Quieres descartar este aviso? Se retirará de la bandeja de pendientes sin crear ningún movimiento ni modificar saldos.
                </p>
                <div className="mt-6 flex justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleCloseReview}
                    disabled={isSubmittingAction}
                    className="rounded-xl px-4 py-2 text-sm font-semibold text-[#66796f]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleDismiss}
                    disabled={isSubmittingAction}
                    className="rounded-xl bg-[#9a493e] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#7e3930] disabled:opacity-50"
                  >
                    {isSubmittingAction ? 'Descartando…' : 'Confirmar descarte'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
