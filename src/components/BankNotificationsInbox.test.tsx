import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BankNotificationsInbox } from './BankNotificationsInbox'
import type {
  BankCardAccountLink,
  BankNotification,
  FinancialAccount,
  FinancialCategory,
  FinancialTransaction,
} from '../types/finance'

const mockAccounts: FinancialAccount[] = [
  {
    id: 'acc-1',
    user_id: 'user-1',
    name: 'Bancolombia Ahorros 8422',
    account_type: 'bank',
    currency: 'COP',
    initial_balance: 1000000,
    archived_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  },
  {
    id: 'acc-2',
    user_id: 'user-1',
    name: 'Bancolombia Corriente',
    account_type: 'bank',
    currency: 'COP',
    initial_balance: 500000,
    archived_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  },
]

const mockCategories: FinancialCategory[] = [
  {
    id: 'cat-hogar',
    user_id: 'user-1',
    kind: 'expense',
    parent_id: null,
    name: 'Hogar',
    archived_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  },
  {
    id: 'cat-transfers',
    user_id: 'user-1',
    kind: 'income',
    parent_id: null,
    name: 'Transferencias',
    archived_at: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  },
]

const mockCardAccountLinks: BankCardAccountLink[] = [
  {
    id: 'link-1',
    user_id: 'user-1',
    identifier_type: 'card',
    last_digits: '0541',
    account_id: 'acc-1',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  },
]

describe('BankNotificationsInbox', () => {
  it('pega PSE aprobado, muestra CUS sin hora y propone gasto sin registrarlo', async () => {
    const onConfirmTransaction = vi.fn()
    const onCreateNotification = vi.fn().mockImplementation(async (parsed) => ({
      ...parsed, id: 'pse-1', user_id: 'user-1', client_request_id: 'req-pse',
      source_channel: 'manual', currency: 'COP', status: 'pending',
      resolved_transaction_id: null, resolution_request_id: null,
      dismissed_at: null, resolved_at: null, created_at: '', updated_at: '',
    }))
    render(<BankNotificationsInbox notifications={[]} cardAccountLinks={mockCardAccountLinks} accounts={mockAccounts} categories={mockCategories} transactions={[]} onCreateNotification={onCreateNotification} onConfirmTransaction={onConfirmTransaction} onConfirmTransfer={vi.fn()} onLinkTransaction={vi.fn()} onDismissNotification={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Texto de la notificación bancaria'), { target: { value: 'Estado de la Transacción: Aprobada\nValor: $ 27.500,00\nEmpresa: EMPRESA DE PRUEBA S.A.S.\nDescripción: COMPRA DE PRUEBA\nFecha de la transacción: 07/11/2026\nCUS: 000123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar aviso' }))
    await waitFor(() => expect(onCreateNotification).toHaveBeenCalledWith(expect.objectContaining({ amount: 27500, occurred_on: '2026-11-07', occurred_time: null, provider_reference: '000123456' })))
    expect(screen.getByRole('dialog').textContent).toContain('CUS: 000123456')
    expect(screen.getByLabelText('Cuenta en Ordia')).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Registrar gasto' })).toBeInTheDocument()
    expect(onConfirmTransaction).not.toHaveBeenCalled()
  })

  it('ofrece vincular PSE al gasto ya asociado a un aviso bancario, solo tras elegirlo', async () => {
    const base: BankNotification = {
      id: 'pse-1', user_id: 'user-1', client_request_id: 'req-pse', bank_name: 'PSE/ACH Colombia',
      source_channel: 'gmail', notification_type: 'purchase', amount: 27500, currency: 'COP',
      occurred_on: '2026-11-07', occurred_time: null, provider_reference: '000123456',
      merchant: 'EMPRESA DE PRUEBA S.A.S.', account_last_digits: null, card_last_digits: null,
      card_type: null, counterparty_name: null, counterparty_account_last_digits: null,
      status: 'pending', resolved_transaction_id: null, resolution_request_id: null,
      dismissed_at: null, resolved_at: null, created_at: '', updated_at: '',
    }
    const tx: FinancialTransaction = {
      id: 'tx-1', user_id: 'user-1', kind: 'expense', account_id: 'acc-1',
      destination_account_id: null, amount: 27500, occurred_on: '2026-11-07',
      category_id: 'cat-hogar', description: 'Pago registrado', client_request_id: 'req-tx',
      deleted_at: null, created_at: '', updated_at: '',
    }
    const onLinkTransaction = vi.fn().mockResolvedValue(undefined)
    render(<BankNotificationsInbox notifications={[base, { ...base, id: 'bank-1', bank_name: 'Bancolombia', occurred_time: '10:03', provider_reference: null, status: 'resolved', resolved_transaction_id: tx.id, resolved_at: '2026-11-07T15:03:00Z' }]} cardAccountLinks={[]} accounts={mockAccounts} categories={mockCategories} transactions={[tx]} onCreateNotification={vi.fn()} onConfirmTransaction={vi.fn()} onConfirmTransfer={vi.fn()} onLinkTransaction={onLinkTransaction} onDismissNotification={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ya lo registré' }))
    expect(screen.getByText('Pago registrado')).toBeInTheDocument()
    expect(onLinkTransaction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: 'Vincular a este movimiento' }))
    await waitFor(() => expect(onLinkTransaction).toHaveBeenCalledWith('pse-1', 'tx-1'))
  })
  it('renderiza estado inicial sin avisos pendientes', () => {
    render(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={[]}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    expect(screen.getByText('Movimientos por revisar')).toBeInTheDocument()
    expect(screen.getByText('Sin pendientes')).toBeInTheDocument()
    expect(
      screen.getByText(/No tienes movimientos pendientes por revisar/i),
    ).toBeInTheDocument()
  })

  it('pega y crea pendiente para el Ejemplo 1 (transferencia recibida $22.000)', async () => {
    const onCreateNotification = vi.fn().mockResolvedValue({
      id: 'notif-1',
      user_id: 'user-1',
      client_request_id: 'req-1',
      bank_name: 'Bancolombia',
      source_channel: 'manual',
      notification_type: 'transfer_received',
      amount: 22000,
      currency: 'COP',
      occurred_on: '2026-10-31',
      occurred_time: '13:28',
      merchant: null,
      account_last_digits: '8422',
      card_last_digits: null,
      card_type: null,
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '2026-10-31T13:28:00Z',
      updated_at: '2026-10-31T13:28:00Z',
    })

    render(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={onCreateNotification}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    const textarea = screen.getByLabelText('Texto de la notificación bancaria')
    fireEvent.change(textarea, {
      target: {
        value: 'Bancolombia: Recibiste una transferencia por $22,000 de "" en tu cuenta **8422, el 31/10/2026 a las 13:28.',
      },
    })

    const submitBtn = screen.getByRole('button', { name: 'Revisar aviso' })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(onCreateNotification).toHaveBeenCalledTimes(1)
    })

    expect(onCreateNotification).toHaveBeenCalledWith({
      bank_name: 'Bancolombia',
      notification_type: 'transfer_received',
      amount: 22000,
      occurred_on: '2026-10-31',
      occurred_time: '13:28',
      merchant: null,
      account_last_digits: '8422',
      card_last_digits: null,
      card_type: null,
      counterparty_name: null,
      counterparty_account_last_digits: null,
    })

    // Se abre el diálogo con opciones para entrada
    expect(screen.getByRole('button', { name: 'Registrar ingreso' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Transferencia entre mis cuentas' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ya lo registré' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Descartar' })).toBeInTheDocument()
  })

  it('pega y crea pendiente para el Ejemplo 2 (compra $39.900 en HOMECENTER con tarjeta 0541)', async () => {
    const onCreateNotification = vi.fn().mockResolvedValue({
      id: 'notif-2',
      user_id: 'user-1',
      client_request_id: 'req-2',
      bank_name: 'Bancolombia',
      source_channel: 'manual',
      notification_type: 'purchase',
      amount: 39900,
      currency: 'COP',
      occurred_on: '2026-10-17',
      occurred_time: '13:17',
      merchant: 'HOMECENTER RIONEGRO',
      account_last_digits: null,
      card_last_digits: '0541',
      card_type: 'debit',
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '2026-10-17T13:17:00Z',
      updated_at: '2026-10-17T13:17:00Z',
    })

    render(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={onCreateNotification}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    const textarea = screen.getByLabelText('Texto de la notificación bancaria')
    fireEvent.change(textarea, {
      target: {
        value: 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Revisar aviso' }))

    await waitFor(() => {
      expect(onCreateNotification).toHaveBeenCalledTimes(1)
    })

    expect(onCreateNotification).toHaveBeenCalledWith({
      bank_name: 'Bancolombia',
      notification_type: 'purchase',
      amount: 39900,
      occurred_on: '2026-10-17',
      occurred_time: '13:17',
      merchant: 'HOMECENTER RIONEGRO',
      account_last_digits: null,
      card_last_digits: '0541',
      card_type: 'debit',
      counterparty_name: null,
      counterparty_account_last_digits: null,
    })

    // Opciones para compra: Registrar gasto, Ya lo registré, Descartar
    expect(screen.getByRole('button', { name: 'Registrar gasto' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Registrar ingreso' })).not.toBeInTheDocument()
  })

  it('pega y crea pendiente para el Ejemplo 3 (transferencia enviada $200.000 con año de 2 dígitos)', async () => {
    const onCreateNotification = vi.fn().mockResolvedValue({
      id: 'notif-3',
      user_id: 'user-1',
      client_request_id: 'req-3',
      bank_name: 'Bancolombia',
      source_channel: 'manual',
      notification_type: 'transfer_sent',
      amount: 200000,
      currency: 'COP',
      occurred_on: '2026-10-20',
      occurred_time: '21:15',
      merchant: null,
      account_last_digits: '8422',
      card_last_digits: null,
      card_type: null,
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '2026-10-20T21:15:00Z',
      updated_at: '2026-10-20T21:15:00Z',
    })

    render(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={onCreateNotification}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    const textarea = screen.getByLabelText('Texto de la notificación bancaria')
    fireEvent.change(textarea, {
      target: {
        value: 'Bancolombia: Transferiste $200,000.00 desde tu cuenta *8422 a la cuenta *"" el 20/10/26 a las 21:15.',
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Revisar aviso' }))

    await waitFor(() => {
      expect(onCreateNotification).toHaveBeenCalledTimes(1)
    })

    expect(onCreateNotification).toHaveBeenCalledWith({
      bank_name: 'Bancolombia',
      notification_type: 'transfer_sent',
      amount: 200000,
      occurred_on: '2026-10-20',
      occurred_time: '21:15',
      merchant: null,
      account_last_digits: '8422',
      card_last_digits: null,
      card_type: null,
      counterparty_name: null,
      counterparty_account_last_digits: null,
    })

    // Opciones para salida por transferencia
    expect(screen.getByRole('button', { name: 'Registrar gasto' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Transferencia entre mis cuentas' })).toBeInTheDocument()
  })

  it('muestra error explicativo si el texto es incompleto sin llamar a la creación', () => {
    const onCreateNotification = vi.fn()
    render(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={onCreateNotification}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    const textarea = screen.getByLabelText('Texto de la notificación bancaria')
    fireEvent.change(textarea, {
      target: {
        value: 'Bancolombia: Compraste en Tienda el 10/10/2026', // Falta importe y hora
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Revisar aviso' }))

    expect(onCreateNotification).not.toHaveBeenCalled()
    expect(screen.getByText(/No pudimos encontrar el importe en pesos/i)).toBeInTheDocument()
  })

  it('identifica y muestra aviso de posible coincidencia ante dos avisos con mismo importe y fecha', () => {
    const pendingList: BankNotification[] = [
      {
        id: 'notif-a',
        user_id: 'user-1',
        client_request_id: 'req-a',
        bank_name: 'Bancolombia',
        source_channel: 'manual',
        notification_type: 'purchase',
        amount: 39900,
        currency: 'COP',
        occurred_on: '2026-10-17',
        occurred_time: '13:17',
        merchant: 'HOMECENTER RIONEGRO',
        account_last_digits: null,
        card_last_digits: '0541',
        card_type: 'debit',
        counterparty_name: null,
        counterparty_account_last_digits: null,
        status: 'pending',
        resolved_transaction_id: null,
        resolution_request_id: null,
        dismissed_at: null,
        resolved_at: null,
        created_at: '2026-10-17T13:17:00Z',
        updated_at: '2026-10-17T13:17:00Z',
      },
      {
        id: 'notif-b',
        user_id: 'user-1',
        client_request_id: 'req-b',
        bank_name: 'Bancolombia',
        source_channel: 'manual',
        notification_type: 'purchase',
        amount: 39900,
        currency: 'COP',
        occurred_on: '2026-10-17',
        occurred_time: '15:30',
        merchant: 'HOMECENTER RIONEGRO',
        account_last_digits: null,
        card_last_digits: '0541',
        card_type: 'debit',
        counterparty_name: null,
        counterparty_account_last_digits: null,
        status: 'pending',
        resolved_transaction_id: null,
        resolution_request_id: null,
        dismissed_at: null,
        resolved_at: null,
        created_at: '2026-10-17T15:30:00Z',
        updated_at: '2026-10-17T15:30:00Z',
      },
    ]

    render(
      <BankNotificationsInbox
        notifications={pendingList}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    // Ambos deben mostrar la etiqueta "Posible coincidencia"
    const badges = screen.getAllByText('Posible coincidencia')
    expect(badges).toHaveLength(2)
  })

  it('permite registrar gasto recordando la asociación de tarjeta a cuenta', async () => {
    const onConfirmTransaction = vi.fn().mockResolvedValue(undefined)
    const pendingList: BankNotification[] = [
      {
        id: 'notif-purchase',
        user_id: 'user-1',
        client_request_id: 'req-p',
        bank_name: 'Bancolombia',
        source_channel: 'manual',
        notification_type: 'purchase',
        amount: 39900,
        currency: 'COP',
        occurred_on: '2026-10-17',
        occurred_time: '13:17',
        merchant: 'HOMECENTER RIONEGRO',
        account_last_digits: null,
        card_last_digits: '0541',
        card_type: 'debit',
        counterparty_name: null,
        counterparty_account_last_digits: null,
        status: 'pending',
        resolved_transaction_id: null,
        resolution_request_id: null,
        dismissed_at: null,
        resolved_at: null,
        created_at: '2026-10-17T13:17:00Z',
        updated_at: '2026-10-17T13:17:00Z',
      },
    ]

    render(
      <BankNotificationsInbox
        notifications={pendingList}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={onConfirmTransaction}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    // Abrir revisión
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))

    // Verificar que preselecciona la cuenta acc-1 asociada a la tarjeta 0541
    const accountSelect = screen.getByLabelText('Cuenta en Ordia')
    expect(accountSelect).toHaveValue('acc-1')

    // Confirmar gasto
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y registrar' }))

    await waitFor(() => {
      expect(onConfirmTransaction).toHaveBeenCalledTimes(1)
    })

    expect(onConfirmTransaction).toHaveBeenCalledWith(
      'notif-purchase',
      expect.any(String),
      expect.objectContaining({
        kind: 'expense',
        account_id: 'acc-1',
        category_id: 'cat-hogar',
        description: 'HOMECENTER RIONEGRO',
        occurred_on: '2026-10-17',
        remember_link: true,
        identifier_type: 'card',
        last_digits: '0541',
      }),
    )
  })

  it('permite "Ya lo registré" vinculando a un movimiento existente sin crear duplicados', async () => {
    const onLinkTransaction = vi.fn().mockResolvedValue(undefined)
    const onConfirmTransaction = vi.fn()

    const pendingNotification: BankNotification = {
      id: 'notif-link-test',
      user_id: 'user-1',
      client_request_id: 'req-lt',
      bank_name: 'Bancolombia',
      source_channel: 'manual',
      notification_type: 'transfer_received',
      amount: 22000,
      currency: 'COP',
      occurred_on: '2026-10-31',
      occurred_time: '13:28',
      merchant: null,
      account_last_digits: '8422',
      card_last_digits: null,
      card_type: null,
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '2026-10-31T13:28:00Z',
      updated_at: '2026-10-31T13:28:00Z',
    }

    const mockTransactions: FinancialTransaction[] = [
      {
        id: 'tx-existing-22k',
        user_id: 'user-1',
        kind: 'income',
        account_id: 'acc-1',
        destination_account_id: null,
        amount: 22000,
        occurred_on: '2026-10-31',
        category_id: 'cat-transfers',
        description: 'Abono recibido manualmente',
        client_request_id: 'req-old',
        deleted_at: null,
        created_at: '2026-10-31T13:00:00Z',
        updated_at: '2026-10-31T13:00:00Z',
      },
    ]

    render(
      <BankNotificationsInbox
        notifications={[pendingNotification]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={mockTransactions}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={onConfirmTransaction}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={onLinkTransaction}
        onDismissNotification={vi.fn()}
      />,
    )

    // Abrir revisión
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))

    // Cambiar al modo "Ya lo registré"
    fireEvent.click(screen.getByRole('button', { name: 'Ya lo registré' }))

    // Debe mostrar el movimiento compatible de 22.000
    expect(screen.getByText('Abono recibido manualmente')).toBeInTheDocument()

    // Seleccionar y vincular
    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: 'Vincular a este movimiento' }))

    await waitFor(() => {
      expect(onLinkTransaction).toHaveBeenCalledTimes(1)
    })

    expect(onLinkTransaction).toHaveBeenCalledWith('notif-link-test', 'tx-existing-22k')
    // No se llamó a crear transacción
    expect(onConfirmTransaction).not.toHaveBeenCalled()
  })

  it('permite registrar una transferencia entre cuentas propias requiriendo ambas cuentas', async () => {
    const onConfirmTransfer = vi.fn().mockResolvedValue(undefined)
    const pendingTransfer: BankNotification = {
      id: 'notif-transfer',
      user_id: 'user-1',
      client_request_id: 'req-ts',
      bank_name: 'Bancolombia',
      source_channel: 'manual',
      notification_type: 'transfer_sent',
      amount: 200000,
      currency: 'COP',
      occurred_on: '2026-10-20',
      occurred_time: '21:15',
      merchant: null,
      account_last_digits: '8422',
      card_last_digits: null,
      card_type: null,
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '2026-10-20T21:15:00Z',
      updated_at: '2026-10-20T21:15:00Z',
    }

    render(
      <BankNotificationsInbox
        notifications={[pendingTransfer]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={onConfirmTransfer}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Transferencia entre mis cuentas' }))

    // Seleccionar origen acc-1 y destino acc-2
    fireEvent.change(screen.getByLabelText('Cuenta de origen'), { target: { value: 'acc-1' } })
    fireEvent.change(screen.getByLabelText('Cuenta de destino'), { target: { value: 'acc-2' } })

    fireEvent.click(screen.getByRole('button', { name: 'Registrar transferencia' }))

    await waitFor(() => {
      expect(onConfirmTransfer).toHaveBeenCalledTimes(1)
    })

    expect(onConfirmTransfer).toHaveBeenCalledWith(
      'notif-transfer',
      expect.any(String),
      expect.objectContaining({
        account_id: 'acc-1',
        destination_account_id: 'acc-2',
        occurred_on: '2026-10-20',
      }),
    )
  })

  it('permite descartar el aviso pendiente', async () => {
    const onDismissNotification = vi.fn().mockResolvedValue(undefined)
    const pendingNotification: BankNotification = {
      id: 'notif-discard',
      user_id: 'user-1',
      client_request_id: 'req-d',
      bank_name: 'Bancolombia',
      source_channel: 'manual',
      notification_type: 'purchase',
      amount: 15000,
      currency: 'COP',
      occurred_on: '2026-10-15',
      occurred_time: '10:00',
      merchant: 'Café',
      account_last_digits: null,
      card_last_digits: null,
      card_type: null,
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '2026-10-15T10:00:00Z',
      updated_at: '2026-10-15T10:00:00Z',
    }

    render(
      <BankNotificationsInbox
        notifications={[pendingNotification]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={onDismissNotification}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar descarte' }))

    await waitFor(() => {
      expect(onDismissNotification).toHaveBeenCalledWith('notif-discard')
    })
  })

  it('distingue «Bandeja no disponible» de «Sin pendientes» cuando falta la migración', () => {
    render(
      <BankNotificationsInbox
        isAvailable={false}
        notifications={[]}
        cardAccountLinks={[]}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    expect(screen.getByText('Bandeja no disponible')).toBeInTheDocument()
    expect(screen.queryByText('Sin pendientes')).not.toBeInTheDocument()
    expect(screen.getByText(/Falta aplicar la migración de base de datos/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Texto de la notificación bancaria')).not.toBeInTheDocument()
  })

  it('rechaza centavos distintos de cero y nunca muestra éxito si falla el guardado del pendiente', async () => {
    const onCreateNotification = vi.fn().mockRejectedValueOnce(new Error('No pudimos guardar el aviso bancario pendiente.'))

    render(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        onCreateNotification={onCreateNotification}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    const textarea = screen.getByLabelText('Texto de la notificación bancaria')
    // 1. Centavos distintos de cero -> no intenta crear el pendiente
    fireEvent.change(textarea, {
      target: {
        value: 'Bancolombia: Compraste $39.900,50 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar aviso' }))
    expect(onCreateNotification).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(/centavos distintos de cero/i)

    // 2. Aviso válido pero falla el servidor -> muestra error, conserva el texto y NO abre diálogo de éxito
    const validNotice = 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.'
    fireEvent.change(textarea, { target: { value: validNotice } })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar aviso' }))

    await waitFor(() => expect(onCreateNotification).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('alert')).toHaveTextContent('No pudimos guardar el aviso bancario pendiente.')
    expect(textarea).toHaveValue(validNotice)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('en «Ya lo registré» filtra por sentido, cuenta conocida y vigencia, y deja elegir si hay varias coincidencias', async () => {
    const onLinkTransaction = vi.fn().mockResolvedValue(undefined)
    const linksWithAccount: BankCardAccountLink[] = [
      ...mockCardAccountLinks,
      {
        id: 'link-acc-8422',
        user_id: 'user-1',
        identifier_type: 'account',
        last_digits: '8422',
        account_id: 'acc-1',
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ]

    const incomingNotification: BankNotification = {
      id: 'notif-in-22k',
      user_id: 'user-1',
      client_request_id: 'req-in',
      bank_name: 'Bancolombia',
      source_channel: 'manual',
      notification_type: 'transfer_received',
      amount: 22000,
      currency: 'COP',
      occurred_on: '2026-10-31',
      occurred_time: '13:28',
      merchant: null,
      account_last_digits: '8422',
      card_last_digits: null,
      card_type: null,
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '2026-10-31T13:28:00Z',
      updated_at: '2026-10-31T13:28:00Z',
    }

    const candidateTransactions: FinancialTransaction[] = [
      // Inválido: es gasto en vez de entrada
      {
        id: 'tx-expense-wrong-kind',
        user_id: 'user-1',
        kind: 'expense',
        account_id: 'acc-1',
        destination_account_id: null,
        amount: 22000,
        occurred_on: '2026-10-31',
        category_id: 'cat-hogar',
        description: 'Gasto incompatible',
        client_request_id: 'r1',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      // Inválido: ingreso pero en otra cuenta distinta a la asociada (**8422 -> acc-1)
      {
        id: 'tx-income-wrong-account',
        user_id: 'user-1',
        kind: 'income',
        account_id: 'acc-2',
        destination_account_id: null,
        amount: 22000,
        occurred_on: '2026-10-31',
        category_id: 'cat-transfers',
        description: 'Ingreso otra cuenta',
        client_request_id: 'r2',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      // Inválido: transferencia propia donde acc-1 es ORIGEN en vez de DESTINO
      {
        id: 'tx-transfer-wrong-dir',
        user_id: 'user-1',
        kind: 'transfer',
        account_id: 'acc-1',
        destination_account_id: 'acc-2',
        amount: 22000,
        occurred_on: '2026-10-31',
        category_id: null,
        description: 'Salida desde 8422',
        client_request_id: 'r3',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      // Válido #1: ingreso en acc-1
      {
        id: 'tx-valid-income',
        user_id: 'user-1',
        kind: 'income',
        account_id: 'acc-1',
        destination_account_id: null,
        amount: 22000,
        occurred_on: '2026-10-31',
        category_id: 'cat-transfers',
        description: 'Ingreso directo en 8422',
        client_request_id: 'r4',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      // Válido #2: transferencia propia donde acc-1 es DESTINO
      {
        id: 'tx-valid-transfer-dest',
        user_id: 'user-1',
        kind: 'transfer',
        account_id: 'acc-2',
        destination_account_id: 'acc-1',
        amount: 22000,
        occurred_on: '2026-10-31',
        category_id: null,
        description: 'Traspaso desde corriente a 8422',
        client_request_id: 'r5',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
    ]

    render(
      <BankNotificationsInbox
        notifications={[incomingNotification]}
        cardAccountLinks={linksWithAccount}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={candidateTransactions}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={onLinkTransaction}
        onDismissNotification={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))

    // En modo transferencia propia de entrada, debe preseleccionar acc-1 como destino y acc-2 como origen
    fireEvent.click(screen.getByRole('button', { name: 'Transferencia entre mis cuentas' }))
    expect(screen.getByLabelText('Cuenta de destino')).toHaveValue('acc-1')
    expect(screen.getByLabelText('Cuenta de origen')).toHaveValue('acc-2')

    // Cambiar a «Ya lo registré»
    fireEvent.click(screen.getByRole('button', { name: 'Ya lo registré' }))

    expect(screen.queryByText('Gasto incompatible')).not.toBeInTheDocument()
    expect(screen.queryByText('Ingreso otra cuenta')).not.toBeInTheDocument()
    expect(screen.queryByText('Salida desde 8422')).not.toBeInTheDocument()

    // Presenta las dos opciones válidas para que la persona elija explícitamente
    expect(screen.getByText(/2 movimientos compatibles/i)).toBeInTheDocument()
    expect(screen.getByText('Ingreso directo en 8422')).toBeInTheDocument()
    expect(screen.getByText('Traspaso desde corriente a 8422')).toBeInTheDocument()

    const radios = screen.getAllByRole('radio')
    expect(radios).toHaveLength(2)
    fireEvent.click(radios[1])
    fireEvent.click(screen.getByRole('button', { name: 'Vincular a este movimiento' }))

    await waitFor(() => {
      expect(onLinkTransaction).toHaveBeenCalledWith('notif-in-22k', 'tx-valid-transfer-dest')
    })
  })

  it('permite buscar subcategoría escribiendo al resolver un aviso bancario y conserva su ID', async () => {
    const onConfirmTransaction = vi.fn().mockResolvedValue(undefined)
    const extendedCategories: FinancialCategory[] = [
      ...mockCategories,
      {
        id: 'cat-ferreteria',
        user_id: 'user-1',
        kind: 'expense',
        parent_id: 'cat-hogar',
        name: 'Ferretería',
        archived_at: null,
        created_at: '',
        updated_at: '',
      },
    ]
    const pendingPurchase: BankNotification = {
      id: 'notif-cat-search',
      user_id: 'user-1',
      client_request_id: 'req-cs',
      bank_name: 'Bancolombia',
      source_channel: 'manual',
      notification_type: 'purchase',
      amount: 39900,
      currency: 'COP',
      occurred_on: '2026-10-17',
      occurred_time: '13:17',
      merchant: 'HOMECENTER RIONEGRO',
      account_last_digits: null,
      card_last_digits: '0541',
      card_type: 'debit',
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '',
      updated_at: '',
    }

    render(
      <BankNotificationsInbox
        notifications={[pendingPurchase]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={extendedCategories}
        transactions={[]}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={onConfirmTransaction}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))
    fireEvent.click(screen.getByLabelText('Categoría'))
    const searchInput = screen.getByRole('combobox', { name: 'Buscar categoría o subcategoría' })
    fireEvent.change(searchInput, { target: { value: 'ferreteria' } })
    fireEvent.click(screen.getByRole('option', { name: 'Hogar → Ferretería' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y registrar' }))

    await waitFor(() => {
      expect(onConfirmTransaction).toHaveBeenCalledWith(
        'notif-cat-search',
        expect.any(String),
        expect.objectContaining({
          category_id: 'cat-ferreteria',
          account_id: 'acc-1',
        }),
      )
    })
  })

  it('muestra «Conectar mi correo» en sus 4 estados, distingue dirección confirmada de primer aviso recibido y no simula un dominio inexistente', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onEnsureOrReplaceAlias = vi.fn()
    const onConfirmAlias = vi.fn()
    const onDisableAlias = vi.fn()

    // 1. Sin dominio configurado: explica que falta configurar el proveedor sin mostrar una dirección inventada
    const { rerender } = render(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        emailAlias={null}
        inboundDomainOverride=""
        onEnsureOrReplaceAlias={onEnsureOrReplaceAlias}
        onConfirmAlias={onConfirmAlias}
        onDisableAlias={onDisableAlias}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    expect(screen.getByText('Sin configurar · Dominio pendiente')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Conectar mi correo' }))
    expect(
      screen.getByText(/Proveedor y dominio de correo entrante pendientes de configurar/i),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generar dirección privada' })).not.toBeInTheDocument()

    // 2. Con dominio configurado y sin alias («Sin configurar») -> permite generar dirección privada
    onEnsureOrReplaceAlias.mockResolvedValueOnce({
      id: 'alias-1',
      user_id: 'user-1',
      alias_local_part: 'bnc_0123456789abcdef0123456789abcdef',
      status: 'pending_confirmation',
      is_current: true,
      confirmation_code: null,
      confirmation_url: null,
      confirmation_received_at: null,
      confirmed_at: null,
      first_notification_at: null,
      last_notification_at: null,
      disabled_at: null,
      disabled_reason: null,
      created_at: '2026-11-02T01:00:00Z',
      updated_at: '2026-11-02T01:00:00Z',
    })

    rerender(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        emailAlias={null}
        inboundDomainOverride="avisos.resend.app"
        onEnsureOrReplaceAlias={onEnsureOrReplaceAlias}
        onConfirmAlias={onConfirmAlias}
        onDisableAlias={onDisableAlias}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    expect(screen.getByText('Sin configurar')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Generar dirección privada' }))
    await waitFor(() => expect(onEnsureOrReplaceAlias).toHaveBeenCalledWith(false))

    // 3. Estado «Pendiente de confirmación» con código y enlace manual de Gmail (sin reenvío global)
    rerender(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        emailAlias={{
          id: 'alias-1',
          user_id: 'user-1',
          alias_local_part: 'bnc_0123456789abcdef0123456789abcdef',
          status: 'pending_confirmation',
          is_current: true,
          confirmation_code: '847291034',
          confirmation_url: 'https://isolated.mail.google.com/mail/vf-token',
          confirmation_received_at: '2026-11-02T01:05:00Z',
          confirmed_at: null,
          first_notification_at: null,
          last_notification_at: null,
          disabled_at: null,
          disabled_reason: null,
          created_at: '2026-11-02T01:00:00Z',
          updated_at: '2026-11-02T01:05:00Z',
        }}
        inboundDomainOverride="avisos.resend.app"
        onEnsureOrReplaceAlias={onEnsureOrReplaceAlias}
        onConfirmAlias={onConfirmAlias}
        onDisableAlias={onDisableAlias}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    expect(screen.getByText('Pendiente de confirmación · Solicitud recibida')).toBeInTheDocument()
    expect(
      screen.getByText('bnc_0123456789abcdef0123456789abcdef@avisos.resend.app'),
    ).toBeInTheDocument()
    expect(screen.getByText('847291034')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Confirmar reenvío en Google Mail' })).toHaveAttribute(
      'href',
      'https://isolated.mail.google.com/mail/vf-token',
    )
    expect(
      screen.getByText(/No actives el reenvío general de todo tu correo/i),
    ).toBeInTheDocument()

    onConfirmAlias.mockResolvedValueOnce({
      id: 'alias-1',
      user_id: 'user-1',
      alias_local_part: 'bnc_0123456789abcdef0123456789abcdef',
      status: 'active',
      is_current: true,
      confirmation_code: null,
      confirmation_url: null,
      confirmation_received_at: '2026-11-02T01:05:00Z',
      confirmed_at: '2026-11-02T01:06:00Z',
      first_notification_at: null,
      last_notification_at: null,
      disabled_at: null,
      disabled_reason: null,
      created_at: '2026-11-02T01:00:00Z',
      updated_at: '2026-11-02T01:06:00Z',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ya confirmé la dirección en Gmail' }))
    await waitFor(() => expect(onConfirmAlias).toHaveBeenCalledWith('alias-1'))

    // 4. Estado «Activo · Dirección confirmada» vs «Activo · Primer aviso recibido»
    rerender(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        emailAlias={{
          id: 'alias-1',
          user_id: 'user-1',
          alias_local_part: 'bnc_0123456789abcdef0123456789abcdef',
          status: 'active',
          is_current: true,
          confirmation_code: null,
          confirmation_url: null,
          confirmation_received_at: '2026-11-02T01:05:00Z',
          confirmed_at: '2026-11-02T01:06:00Z',
          first_notification_at: null,
          last_notification_at: null,
          disabled_at: null,
          disabled_reason: null,
          created_at: '2026-11-02T01:00:00Z',
          updated_at: '2026-11-02T01:06:00Z',
        }}
        inboundDomainOverride="avisos.resend.app"
        onEnsureOrReplaceAlias={onEnsureOrReplaceAlias}
        onConfirmAlias={onConfirmAlias}
        onDisableAlias={onDisableAlias}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )
    expect(screen.getByText('Activo · Dirección confirmada')).toBeInTheDocument()
    expect(
      screen.getByText(/Todavía no se ha recibido el primer aviso bancario reenviado/i),
    ).toBeInTheDocument()

    rerender(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        emailAlias={{
          id: 'alias-1',
          user_id: 'user-1',
          alias_local_part: 'bnc_0123456789abcdef0123456789abcdef',
          status: 'active',
          is_current: true,
          confirmation_code: null,
          confirmation_url: null,
          confirmation_received_at: '2026-11-02T01:05:00Z',
          confirmed_at: '2026-11-02T01:06:00Z',
          first_notification_at: '2026-11-02T02:10:00Z',
          last_notification_at: '2026-11-02T02:10:00Z',
          disabled_at: null,
          disabled_reason: null,
          created_at: '2026-11-02T01:00:00Z',
          updated_at: '2026-11-02T02:10:00Z',
        }}
        inboundDomainOverride="avisos.resend.app"
        onEnsureOrReplaceAlias={onEnsureOrReplaceAlias}
        onConfirmAlias={onConfirmAlias}
        onDisableAlias={onDisableAlias}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )
    expect(screen.getByText('Activo · Primer aviso recibido')).toBeInTheDocument()

    // Desactivar y reemplazar
    fireEvent.click(screen.getByRole('button', { name: 'Reemplazar' }))
    await waitFor(() => expect(onEnsureOrReplaceAlias).toHaveBeenCalledWith(true))

    fireEvent.click(screen.getByRole('button', { name: 'Desactivar' }))
    await waitFor(() => expect(onDisableAlias).toHaveBeenCalledWith('alias-1'))

    // 5. Estado «Desactivado»
    rerender(
      <BankNotificationsInbox
        notifications={[]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[]}
        emailAlias={{
          id: 'alias-1',
          user_id: 'user-1',
          alias_local_part: 'bnc_0123456789abcdef0123456789abcdef',
          status: 'disabled',
          is_current: true,
          confirmation_code: null,
          confirmation_url: null,
          confirmation_received_at: '2026-11-02T01:05:00Z',
          confirmed_at: '2026-11-02T01:06:00Z',
          first_notification_at: null,
          last_notification_at: null,
          disabled_at: '2026-11-02T02:30:00Z',
          disabled_reason: 'user',
          created_at: '2026-11-02T01:00:00Z',
          updated_at: '2026-11-02T02:30:00Z',
        }}
        inboundDomainOverride="avisos.resend.app"
        onEnsureOrReplaceAlias={onEnsureOrReplaceAlias}
        onConfirmAlias={onConfirmAlias}
        onDisableAlias={onDisableAlias}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )
    expect(screen.getByText('Desactivado')).toBeInTheDocument()
    expect(screen.getByText('Recepción automática desactivada')).toBeInTheDocument()
    confirmSpy.mockRestore()
  })

  it('señala «Posible coincidencia» y «Correo reenviado» cuando un aviso automático coincide con un movimiento ya registrado o pegado manualmente', () => {
    const autoNotification: BankNotification = {
      id: 'notif-gmail-1',
      user_id: 'user-1',
      client_request_id: 'req-g1',
      bank_name: 'Bancolombia',
      source_channel: 'gmail',
      notification_type: 'purchase',
      amount: 39900,
      currency: 'COP',
      occurred_on: '2026-10-17',
      occurred_time: '13:17',
      merchant: 'HOMECENTER RIONEGRO',
      account_last_digits: null,
      card_last_digits: '0541',
      card_type: 'debit',
      counterparty_name: null,
      counterparty_account_last_digits: null,
      status: 'pending',
      resolved_transaction_id: null,
      resolution_request_id: null,
      dismissed_at: null,
      resolved_at: null,
      created_at: '2026-10-17T13:18:00Z',
      updated_at: '2026-10-17T13:18:00Z',
    }

    const alreadyRegisteredTx: FinancialTransaction = {
      id: 'tx-manual-1',
      user_id: 'user-1',
      kind: 'expense',
      account_id: 'acc-1',
      destination_account_id: null,
      amount: 39900,
      occurred_on: '2026-10-17',
      category_id: 'cat-hogar',
      description: 'Compra Homecenter registrada antes',
      client_request_id: 'req-tx-1',
      deleted_at: null,
      created_at: '2026-10-17T13:17:30Z',
      updated_at: '2026-10-17T13:17:30Z',
    }

    render(
      <BankNotificationsInbox
        notifications={[autoNotification]}
        cardAccountLinks={mockCardAccountLinks}
        accounts={mockAccounts}
        categories={mockCategories}
        transactions={[alreadyRegisteredTx]}
        onCreateNotification={vi.fn()}
        onConfirmTransaction={vi.fn()}
        onConfirmTransfer={vi.fn()}
        onLinkTransaction={vi.fn()}
        onDismissNotification={vi.fn()}
      />,
    )

    expect(screen.getByText('Correo reenviado')).toBeInTheDocument()
    expect(screen.getByText('Posible coincidencia')).toBeInTheDocument()
  })
})
