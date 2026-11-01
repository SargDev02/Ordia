import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { BankCardAccountLink, BankNotification, FinancialAccount, FinancialCategory, FinancialTransaction, FixedExpense, FixedExpensePeriod } from '../types/finance'
import { HomePage } from './HomePage'

vi.mock('../components/HomeTasks', () => ({ HomeTasks: () => <div>Checklist de tareas</div> }))
vi.mock('../components/HomeCalendar', () => ({ HomeCalendar: () => <div>Agenda de eventos</div> }))

const mocks = vi.hoisted(() => ({
  archiveAccount: vi.fn(),
  createAccount: vi.fn(),
  createTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
  refresh: vi.fn(),
  signOut: vi.fn(),
  updateAccount: vi.fn(),
  updateTransaction: vi.fn(),
  createBankNotification: vi.fn(),
  confirmBankNotificationAsTransaction: vi.fn(),
  confirmBankNotificationAsTransfer: vi.fn(),
  linkBankNotificationToTransaction: vi.fn(),
  dismissBankNotification: vi.fn(),
  saveCardAccountLink: vi.fn(),
  finance: {
    accounts: [] as FinancialAccount[],
    categories: [] as FinancialCategory[],
    fixedExpensePeriods: [] as FixedExpensePeriod[],
    fixedExpenses: [] as FixedExpense[],
    fixedExpenseVersions: [],
    bankInboxAvailable: true,
    bankNotifications: [] as BankNotification[],
    cardAccountLinks: [] as BankCardAccountLink[],
    error: '',
    isLoading: false,
    realtimeStatus: 'connected' as const,
    transactions: [] as FinancialTransaction[],
  },
  archiveCategory: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
}))

function renderHome() {
  return render(<MemoryRouter><HomePage /></MemoryRouter>)
}

vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({
    session: { user: { email: 'usuario@ordia.test' } },
    signOut: mocks.signOut,
  }),
}))

vi.mock('../finance/useFinance', () => ({
  useFinance: () => ({
    ...mocks.finance,
    archiveAccount: mocks.archiveAccount,
    archiveCategory: mocks.archiveCategory,
    createAccount: mocks.createAccount,
    createCategory: mocks.createCategory,
    createTransaction: mocks.createTransaction,
    deleteTransaction: mocks.deleteTransaction,
    refresh: mocks.refresh,
    renameCategory: mocks.renameCategory,
    updateAccount: mocks.updateAccount,
    updateTransaction: mocks.updateTransaction,
    createBankNotification: mocks.createBankNotification,
    confirmBankNotificationAsTransaction: mocks.confirmBankNotificationAsTransaction,
    confirmBankNotificationAsTransfer: mocks.confirmBankNotificationAsTransfer,
    linkBankNotificationToTransaction: mocks.linkBankNotificationToTransaction,
    dismissBankNotification: mocks.dismissBankNotification,
    saveCardAccountLink: mocks.saveCardAccountLink,
  }),
}))

vi.mock('../finance/calculations', async () => ({
  ...await vi.importActual<typeof import('../finance/calculations')>('../finance/calculations'),
  getBogotaToday: () => '2026-10-26',
}))

function account(id: string, name: string): FinancialAccount {
  return {
    account_type: 'bank',
    archived_at: null,
    created_at: '2026-10-26T00:00:00Z',
    currency: 'COP',
    id,
    initial_balance: 0,
    name,
    updated_at: '2026-10-26T00:00:00Z',
    user_id: 'user-a',
  }
}

function category(id: string, name: string, kind: 'income' | 'expense'): FinancialCategory {
  return { archived_at: null, created_at: '', id, kind, name, parent_id: null, updated_at: '', user_id: 'user-a' }
}

describe('acciones financieras rápidas', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.finance.accounts = [account('account-a', 'Principal'), account('account-b', 'Ahorro')]
    mocks.finance.categories = [category('income-category', 'Salario', 'income'), category('expense-category', 'Alimentación', 'expense')]
    mocks.finance.error = ''
    mocks.finance.isLoading = false
    mocks.finance.transactions = []
    mocks.finance.fixedExpensePeriods = []
    mocks.finance.bankInboxAvailable = true
    mocks.finance.bankNotifications = []
    mocks.createAccount.mockResolvedValue(undefined)
    mocks.updateAccount.mockResolvedValue(undefined)
    mocks.createTransaction.mockResolvedValue(undefined)
    mocks.createCategory.mockResolvedValue(undefined)
  })

  it('abre un ingreso preseleccionado y devuelve el foco al cerrar', async () => {
    const user = userEvent.setup()
    renderHome()
    const opener = screen.getByRole('button', { name: 'Registrar ingreso' })

    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Registrar ingreso' })
    expect(within(dialog).getByLabelText('Tipo')).toHaveValue('income')
    expect(within(dialog).getByLabelText('Tipo')).toHaveFocus()

    await user.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
    expect(screen.queryByRole('dialog', { name: 'Registrar ingreso' })).not.toBeInTheDocument()
    await waitFor(() => expect(opener).toHaveFocus())
  })

  it('conserva el formulario cuando se cancela el descarte de cambios', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderHome()

    await user.click(screen.getByRole('button', { name: 'Registrar gasto' }))
    const dialog = screen.getByRole('dialog', { name: 'Registrar gasto' })
    await user.type(within(dialog).getByLabelText('Importe'), '25000')
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar' }))

    expect(confirm).toHaveBeenCalledWith('Tienes cambios sin guardar. ¿Quieres descartarlos?')
    expect(screen.getByRole('dialog', { name: 'Registrar gasto' })).toBeInTheDocument()

    confirm.mockReturnValue(true)
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
    expect(screen.queryByRole('dialog', { name: 'Registrar gasto' })).not.toBeInTheDocument()
  })

  it('buscar no ensucia el movimiento y Escape respeta primero el selector y después el descarte', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    mocks.finance.categories.push({ ...category('child', 'Restaurantes', 'expense'), parent_id: 'expense-category' })
    renderHome()
    const opener = screen.getByRole('button', { name: 'Registrar gasto' })
    await user.click(opener)
    await user.click(screen.getByLabelText('Categoría'))
    await user.type(screen.getByRole('combobox', { name: 'Buscar categoría o subcategoría' }), 'restaurantes')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog', { name: 'Registrar gasto' })).toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Registrar gasto' })).not.toBeInTheDocument()
    expect(confirm).not.toHaveBeenCalled()
    expect(opener).toHaveFocus()

    await user.click(opener)
    await user.click(screen.getByLabelText('Categoría'))
    await user.click(screen.getByRole('option', { name: 'Alimentación → Restaurantes' }))
    await user.keyboard('{Escape}')
    expect(confirm).toHaveBeenCalledWith('Tienes cambios sin guardar. ¿Quieres descartarlos?')
    expect(screen.getByRole('dialog', { name: 'Registrar gasto' })).toBeInTheDocument()
    expect(screen.getByLabelText('Categoría')).toHaveTextContent('Alimentación → Restaurantes')
    confirm.mockReturnValue(true)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Registrar gasto' })).not.toBeInTheDocument()
    expect(mocks.createTransaction).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('explica que una transferencia necesita dos cuentas y facilita crear otra', async () => {
    const user = userEvent.setup()
    mocks.finance.accounts = [account('account-a', 'Principal')]
    renderHome()

    await user.click(screen.getByRole('button', { name: 'Transferir' }))
    const unavailable = screen.getByRole('dialog', { name: 'Operación no disponible' })
    expect(within(unavailable).getByText('Necesitas dos cuentas activas')).toBeInTheDocument()

    await user.click(within(unavailable).getByRole('button', { name: 'Crear una cuenta' }))
    expect(screen.getByRole('dialog', { name: 'Nueva cuenta' })).toBeInTheDocument()
    expect(screen.getByLabelText('Nombre')).toHaveFocus()
  })

  it('muestra validación dentro del formulario y lo cierra después de guardar', async () => {
    const user = userEvent.setup()
    renderHome()

    await user.click(screen.getByRole('button', { name: 'Registrar ingreso' }))
    const dialog = screen.getByRole('dialog', { name: 'Registrar ingreso' })
    await user.click(within(dialog).getByRole('button', { name: 'Guardar movimiento' }))
    expect(within(dialog).getByText('Selecciona una cuenta.')).toBeInTheDocument()

    await user.selectOptions(within(dialog).getByLabelText('Cuenta'), 'account-a')
    await user.type(within(dialog).getByLabelText('Importe'), '150000')
    await user.click(within(dialog).getByRole('button', { name: 'Guardar movimiento' }))

    await waitFor(() => expect(mocks.createTransaction).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ account_id: 'account-a', amount: 150000, kind: 'income' }),
    ))
    expect(screen.queryByRole('dialog', { name: 'Registrar ingreso' })).not.toBeInTheDocument()
  })

  it('trata una selección vacía como ninguna cuenta y permite volver a todas', async () => {
    const user = userEvent.setup()
    renderHome()
    await user.click(screen.getByRole('button', { name: 'Limpiar' }))
    expect(screen.getByText('No hay cuentas seleccionadas')).toBeInTheDocument()
    expect(screen.getAllByText('Ninguna cuenta seleccionada')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Todas' }))
    expect(screen.getAllByText('Todas las cuentas (2)')).toHaveLength(2)
  })

  it('abre la administración y crea una subcategoría buscando la categoría principal sin convertir el campo de nombre en selector', async () => {
    const user = userEvent.setup()
    renderHome()
    await user.click(screen.getByRole('button', { name: 'Administrar categorías' }))
    const dialog = screen.getByRole('dialog', { name: 'Administrar categorías' })
    await user.click(within(dialog).getByLabelText('Nivel'))
    const parentSearch = within(dialog).getByRole('combobox', { name: 'Buscar categoría principal' })
    expect(parentSearch).toHaveFocus()
    await user.type(parentSearch, 'alimentacion')
    await user.click(within(dialog).getByRole('option', { name: 'Subcategoría de Alimentación' }))
    const nameInput = within(dialog).getByLabelText('Nombre')
    expect(nameInput.tagName).toBe('INPUT')
    await user.type(nameInput, 'Restaurantes')
    await user.click(within(dialog).getByRole('button', { name: 'Crear categoría' }))
    await waitFor(() => expect(mocks.createCategory).toHaveBeenCalledWith({
      kind: 'expense',
      name: 'Restaurantes',
      parent_id: 'expense-category',
    }))
  })

  it('solicita teclado numérico en Saldo inicial y permite saldos negativos en móvil con el botón ± Signo al crear y editar cuentas', async () => {
    const user = userEvent.setup()
    renderHome()

    // Crear cuenta con saldo inicial negativo usando el botón ± Signo
    await user.click(screen.getByRole('button', { name: 'Nueva cuenta' }))
    const createDialog = screen.getByRole('dialog', { name: 'Nueva cuenta' })
    await user.type(within(createDialog).getByLabelText('Nombre'), 'Tarjeta saldo pendiente')
    const balanceInput = within(createDialog).getByLabelText('Saldo inicial')
    expect(balanceInput).toHaveAttribute('inputmode', 'numeric')
    await user.clear(balanceInput)
    await user.click(within(createDialog).getByRole('button', { name: 'Cambiar signo del saldo inicial' }))
    await user.type(balanceInput, '250000')
    expect(balanceInput).toHaveValue('-250000')
    await user.click(within(createDialog).getByRole('button', { name: 'Guardar cuenta' }))

    await waitFor(() => expect(mocks.createAccount).toHaveBeenCalledWith({
      account_type: 'bank',
      initial_balance: -250000,
      name: 'Tarjeta saldo pendiente',
    }))

    // Editar cuenta existente conserva inputMode="numeric" y entero exacto
    await user.click(screen.getAllByRole('button', { name: 'Editar' })[0])
    const editDialog = screen.getByRole('dialog', { name: 'Editar cuenta' })
    const editBalanceInput = within(editDialog).getByLabelText('Saldo inicial')
    expect(editBalanceInput).toHaveAttribute('inputmode', 'numeric')
    await user.clear(editBalanceInput)
    await user.type(editBalanceInput, '480000')
    await user.click(within(editDialog).getByRole('button', { name: 'Guardar cuenta' }))

    await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalledWith('account-a', {
      account_type: 'bank',
      initial_balance: 480000,
      name: 'Principal',
    }))
  })

  it('no descuenta obligaciones pendientes del saldo ni de gastos realizados', () => {
    const pendingPeriod: FixedExpensePeriod = {
      cancellation_reason: null, cancelled_at: null, category_id: 'expense-category', created_at: '', currency: 'COP',
      due_date: '2026-10-30', expected_amount: 90000, fixed_expense_id: 'fixed-a', id: 'period-a',
      paid_account_id: null, paid_category_id: null, paid_amount: null, paid_at: null, paid_on: null,
      payment_request_id: null, suggested_account_id: 'account-a', transaction_id: null, updated_at: '', user_id: 'user-a', version_id: 'version-a',
    }
    mocks.finance.fixedExpensePeriods = [pendingPeriod, { ...pendingPeriod, due_date: '2026-11-30', id: 'period-b' }]
    renderHome()
    const balance = screen.getByText('Saldo total').closest('article') as HTMLElement
    const expenses = screen.getByText('Gastos del período').closest('article') as HTMLElement
    expect(balance).toHaveTextContent('$ 0')
    expect(expenses).toHaveTextContent('$ 0')
    const obligations = screen.getByLabelText('Obligaciones del mes')
    expect(obligations).toHaveTextContent('Pendientes del mes · 1')
    expect(obligations).toHaveTextContent('90.000')
    expect(obligations).toHaveTextContent('Vencidos · 0')
    expect(obligations).toHaveTextContent('Los meses futuros se consultan en el detalle')
    expect(mocks.createTransaction).not.toHaveBeenCalled()
  })

  it('renderiza la sección de sugerencias financieras accesible desde el resumen', () => {
    const pendingPeriod: FixedExpensePeriod = {
      cancellation_reason: null, cancelled_at: null, category_id: 'expense-category', created_at: '', currency: 'COP',
      due_date: '2026-10-28', expected_amount: 150000, fixed_expense_id: 'fixed-a', id: 'period-a',
      paid_account_id: null, paid_category_id: null, paid_amount: null, paid_at: null, paid_on: null,
      payment_request_id: null, suggested_account_id: 'account-a', transaction_id: null, updated_at: '', user_id: 'user-a', version_id: 'version-a',
    }
    mocks.finance.fixedExpenses = [{
      id: 'fixed-a',
      user_id: 'user-a',
      client_request_id: 'fe-a',
      name: 'Internet Hogar',
      notes: null,
      status: 'active',
      paused_at: null,
      deleted_at: null,
      created_at: '',
      updated_at: '',
    }]
    mocks.finance.fixedExpensePeriods = [pendingPeriod]
    renderHome()

    const link = screen.getByRole('link', { name: /Ver sugerencias financieras/i })
    expect(link).toHaveAttribute('href', '#sugerencias-financieras')

    const suggestionsSection = screen.getByLabelText('Sugerencias y análisis financiero')
    expect(suggestionsSection).toBeInTheDocument()
    expect(suggestionsSection).toHaveTextContent('Pagos próximos (2026-10-26 a 2026-11-01)')
    expect(suggestionsSection).toHaveTextContent('Internet Hogar')
  })

  it('renderiza la bandeja de movimientos por revisar accesible desde el resumen', () => {
    mocks.finance.bankNotifications = [
      {
        id: 'notif-pending-1',
        user_id: 'user-a',
        client_request_id: 'req-np1',
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

    renderHome()

    const link = screen.getByRole('link', { name: /Movimientos por revisar/i })
    expect(link).toHaveAttribute('href', '#movimientos-por-revisar')

    const inboxSection = screen.getByLabelText('Bandeja de avisos bancarios por revisar')
    expect(inboxSection).toBeInTheDocument()
    expect(inboxSection).toHaveTextContent('1 por revisar')
    expect(inboxSection).toHaveTextContent('HOMECENTER RIONEGRO')
    expect(inboxSection).toHaveTextContent('39.900')
  })
})
