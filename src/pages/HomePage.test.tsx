import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  it('recorre crear, editar y eliminar un ajuste con confirmación conservando ingresos y gastos', async () => {
    const user = userEvent.setup()
    mocks.finance.accounts = [{ ...account('account-a', 'Principal'), initial_balance: 50000 }]
    mocks.createTransaction.mockImplementation(async (requestId, input) => {
      mocks.finance.transactions = [{ ...input, id: 'adjustment', client_request_id: requestId, user_id: 'user-a',
        created_at: '', updated_at: '', deleted_at: null }]
    })
    mocks.updateTransaction.mockImplementation(async (id, input) => {
      mocks.finance.transactions = mocks.finance.transactions.map(tx => tx.id === id ? { ...tx, ...input } : tx)
    })
    mocks.deleteTransaction.mockImplementation(async (id) => {
      mocks.finance.transactions = mocks.finance.transactions.map(tx => tx.id === id ? { ...tx, deleted_at: '2026-11-11T12:00:00Z' } : tx)
    })
    renderHome()
    function checkBalance(amount: string) {
      expect(screen.getByText('Saldo total').closest('article')).toHaveTextContent(amount)
      expect(screen.getByText('Ingresos del período').closest('article')).toHaveTextContent(/\$\s*0/)
      expect(screen.getByText('Gastos del período').closest('article')).toHaveTextContent(/\$\s*0/)
    }
    checkBalance('50.000')
    await user.click(screen.getByRole('button', { name: 'Ajuste de saldo' }))
    await user.selectOptions(screen.getByLabelText('Cuenta'), 'account-a')
    await user.type(screen.getByLabelText('Importe'), '3000')
    await user.type(screen.getByLabelText('Motivo (opcional)'), 'Conciliación de prueba')
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    checkBalance('47.000')
    const row = screen.getByText('Conciliación de prueba').closest('article')!
    expect(row).toHaveTextContent(/−.*3.000/)
    expect(row).toHaveTextContent('Principal')
    await user.click(within(row).getByRole('button', { name: 'Editar' }))
    await user.clear(screen.getByLabelText('Importe')); await user.type(screen.getByLabelText('Importe'), '2000')
    expect(screen.getByText(/Saldo actual:/)).toHaveTextContent(/47.000.*48.000/)
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    checkBalance('48.000')
    await user.click(within(screen.getByText('Conciliación de prueba').closest('article')!).getByRole('button', { name: 'Eliminar' }))
    checkBalance('48.000'); expect(mocks.deleteTransaction).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Eliminar movimiento' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    checkBalance('50.000')
    expect(screen.queryByText('Conciliación de prueba')).not.toBeInTheDocument()
    expect(mocks.finance.accounts[0].initial_balance).toBe(50000)
    mocks.updateTransaction.mockReset(); mocks.deleteTransaction.mockReset()
  })

  it('registra un aumento y muestra el signo positivo en el historial sin ingresos ni gastos', async () => {
    const user = userEvent.setup()
    mocks.finance.accounts = [{ ...account('account-a', 'Principal'), initial_balance: 50000 }]
    mocks.createTransaction.mockImplementation(async (requestId, input) => {
      mocks.finance.transactions = [{ ...input, id: 'increase', client_request_id: requestId, user_id: 'user-a',
        created_at: '', updated_at: '', deleted_at: null }]
    })
    renderHome()
    await user.click(screen.getByRole('button', { name: 'Registrar gasto' }))
    await user.selectOptions(within(screen.getByRole('dialog')).getByLabelText('Tipo'), 'adjustment')
    await user.selectOptions(screen.getByLabelText('Cuenta'), 'account-a')
    await user.selectOptions(screen.getByLabelText('Dirección'), 'increase')
    await user.type(screen.getByLabelText('Importe'), '3000')
    await user.type(screen.getByLabelText('Motivo (opcional)'), 'Aumento de prueba')
    expect(screen.getByText(/Saldo actual:/)).toHaveTextContent(/50.000.*53.000/)
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByText('Aumento de prueba').closest('article')).toHaveTextContent(/\+.*3.000/)
    expect(screen.getByText('Saldo total').closest('article')).toHaveTextContent('53.000')
    expect(screen.getByText('Ingresos del período').closest('article')).toHaveTextContent(/\$\s*0/)
    expect(screen.getByText('Gastos del período').closest('article')).toHaveTextContent(/\$\s*0/)
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

  it('filtra Movimientos por múltiples categorías y subcategorías, nombres repetidos, archivadas con historial, cuentas, fechas y transferencias sin alterar saldos, resúmenes ni sugerencias', async () => {
    const user = userEvent.setup()

    const catServicios = category('cat-servicios', 'Servicios', 'expense')
    const catTelefonia = { ...category('cat-telefonia', 'Telefonía', 'expense'), parent_id: 'cat-servicios' }
    const catEnergia = { ...category('cat-energia', 'Energía', 'expense'), parent_id: 'cat-servicios' }
    const catOtrosIngreso = category('cat-otros-in', 'Otros', 'income')
    const catOtrosGasto = category('cat-otros-ex', 'Otros', 'expense')
    const catArchivadaUsada = {
      ...category('cat-arch-usada', 'Viajes antiguos', 'expense'),
      archived_at: '2026-09-01T00:00:00Z',
    }
    const catArchivadaSinUso = {
      ...category('cat-arch-vacia', 'Categoría nunca usada', 'expense'),
      archived_at: '2026-09-01T00:00:00Z',
    }

    mocks.finance.accounts = [
      { ...account('account-a', 'Principal'), initial_balance: 500000 },
      { ...account('account-b', 'Ahorro'), initial_balance: 200000 },
    ]
    mocks.finance.categories = [
      catServicios,
      catTelefonia,
      catEnergia,
      catOtrosIngreso,
      catOtrosGasto,
      catArchivadaUsada,
      catArchivadaSinUso,
    ]
    mocks.finance.transactions = [
      {
        id: 'tx-servicios-padre',
        user_id: 'user-a',
        kind: 'expense',
        account_id: 'account-a',
        destination_account_id: null,
        amount: 40000,
        occurred_on: '2026-10-20',
        category_id: 'cat-servicios',
        description: 'Administración edificio',
        client_request_id: 'r1',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'tx-telefonia-hija',
        user_id: 'user-a',
        kind: 'expense',
        account_id: 'account-a',
        destination_account_id: null,
        amount: 60000,
        occurred_on: '2026-10-21',
        category_id: 'cat-telefonia',
        description: 'Plan celular octubre',
        client_request_id: 'r2',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'tx-energia-b',
        user_id: 'user-a',
        kind: 'expense',
        account_id: 'account-b',
        destination_account_id: null,
        amount: 85000,
        occurred_on: '2026-10-22',
        category_id: 'cat-energia',
        description: 'Factura energía ahorro',
        client_request_id: 'r3',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'tx-otros-ingreso',
        user_id: 'user-a',
        kind: 'income',
        account_id: 'account-a',
        destination_account_id: null,
        amount: 120000,
        occurred_on: '2026-10-23',
        category_id: 'cat-otros-in',
        description: 'Reembolso recibido',
        client_request_id: 'r4',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'tx-otros-gasto',
        user_id: 'user-a',
        kind: 'expense',
        account_id: 'account-a',
        destination_account_id: null,
        amount: 15000,
        occurred_on: '2026-10-24',
        category_id: 'cat-otros-ex',
        description: 'Gasto menor varios',
        client_request_id: 'r5',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'tx-archivada-hist',
        user_id: 'user-a',
        kind: 'expense',
        account_id: 'account-a',
        destination_account_id: null,
        amount: 30000,
        occurred_on: '2026-10-10',
        category_id: 'cat-arch-usada',
        description: 'Tiquete histórico',
        client_request_id: 'r6',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
      {
        id: 'tx-transferencia',
        user_id: 'user-a',
        kind: 'transfer',
        account_id: 'account-a',
        destination_account_id: 'account-b',
        amount: 50000,
        occurred_on: '2026-10-25',
        category_id: null,
        description: 'Paso a ahorro',
        client_request_id: 'r7',
        deleted_at: null,
        created_at: '',
        updated_at: '',
      },
    ]

    renderHome()

    const totalBalanceCard = screen.getByText('Saldo total').closest('article') as HTMLElement
    const incomeSummaryCard = screen.getByText('Ingresos del período').closest('article') as HTMLElement
    const expenseSummaryCard = screen.getByText('Gastos del período').closest('article') as HTMLElement
    const categoryExpenseHeading = screen.getByRole('heading', { name: 'Gastos del período por categoría' })
    const categoryExpenseSection = categoryExpenseHeading.closest('section') as HTMLElement
    const suggestionsSection = screen.getByLabelText('Sugerencias y análisis financiero')
    const inboxSection = screen.getByLabelText('Bandeja de avisos bancarios por revisar')

    const initialTotalBalanceText = totalBalanceCard.textContent
    const initialIncomeText = incomeSummaryCard.textContent
    const initialExpenseText = expenseSummaryCard.textContent
    const initialCategoryExpenseText = categoryExpenseSection.textContent
    const initialSuggestionsText = suggestionsSection.textContent
    const initialInboxText = inboxSection.textContent

    // Por defecto («Todas las categorías») incluye los 7 movimientos, incluida la transferencia
    expect(screen.getByText('7 movimientos coinciden')).toBeInTheDocument()
    expect(screen.getByText('Paso a ahorro')).toBeInTheDocument()

    // Abrir selector múltiple «Categorías»
    await user.click(screen.getByLabelText('Categorías'))
    const searchInput = screen.getByRole('combobox', { name: 'Buscar categorías para filtrar' })

    // La categoría archivada SIN movimientos históricos no aparece; la archivada CON historial sí aparece
    expect(screen.queryByRole('option', { name: /Categoría nunca usada/i })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Viajes antiguos (archivada)' })).toBeInTheDocument()

    // Nombres repetidos entre ingreso y gasto se distinguen claramente
    expect(screen.getByRole('option', { name: 'Otros · Ingreso' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Otros · Gasto' })).toBeInTheDocument()

    // 1. Seleccionar únicamente la subcategoría «Servicios → Telefonía»: incluye solo su movimiento y excluye transferencias
    await user.type(searchInput, 'telefonia')
    await user.click(screen.getByRole('option', { name: 'Servicios → Telefonía' }))
    expect(screen.getByText('1 movimiento coincide')).toBeInTheDocument()
    expect(screen.getByText('Plan celular octubre')).toBeInTheDocument()
    expect(screen.queryByText('Administración edificio')).not.toBeInTheDocument()
    expect(screen.queryByText('Paso a ahorro')).not.toBeInTheDocument()

    // 2. Seleccionar además la categoría padre «Servicios» al mismo tiempo: incluye padre + hijas sin duplicar «Plan celular octubre»
    await user.clear(searchInput)
    await user.click(screen.getByRole('option', { name: 'Servicios' }))
    expect(screen.getByText('3 movimientos coinciden')).toBeInTheDocument()
    expect(screen.getAllByText('Plan celular octubre')).toHaveLength(1)
    expect(screen.getByText('Administración edificio')).toBeInTheDocument()
    expect(screen.getByText('Factura energía ahorro')).toBeInTheDocument()

    // 3. Combinar con filtro de cuenta (quitar Ahorro) y fecha desde 2026-10-21
    await user.click(screen.getByRole('button', { name: 'Cerrar selector' }))
    // Chips visibles en móvil/escritorio con botón individual para quitar
    const chipsRegion = screen.getByLabelText('Categorías seleccionadas')
    expect(within(chipsRegion).getByRole('button', { name: 'Quitar categoría Servicios → Telefonía' })).toBeInTheDocument()
    expect(within(chipsRegion).getByRole('button', { name: 'Quitar categoría Servicios' })).toBeInTheDocument()

    // Filtrar solo cuenta Principal y Desde 2026-10-21 -> solo queda «Plan celular octubre»
    await user.click(screen.getByRole('checkbox', { name: 'Ahorro' }))
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-21' } })
    expect(screen.getByText('1 movimiento coincide')).toBeInTheDocument()
    expect(screen.getByText('Plan celular octubre')).toBeInTheDocument()
    expect(screen.queryByText('Factura energía ahorro')).not.toBeInTheDocument()
    expect(screen.queryByText('Administración edificio')).not.toBeInTheDocument()

    // 4. Probar estado vacío claro cuando cero movimientos coinciden con la categoría elegida en ese rango
    await user.click(within(chipsRegion).getByRole('button', { name: 'Quitar categoría Servicios → Telefonía' }))
    await user.click(within(chipsRegion).getByRole('button', { name: 'Quitar categoría Servicios' }))
    await user.click(screen.getByLabelText('Categorías'))
    await user.click(screen.getByRole('option', { name: 'Viajes antiguos (archivada)' }))
    await user.click(screen.getByRole('button', { name: 'Cerrar selector' }))
    expect(screen.getByText('0 movimientos coinciden')).toBeInTheDocument()
    expect(screen.getByText('No hay movimientos en las categorías seleccionadas')).toBeInTheDocument()
    expect(
      screen.getByText(/Ningún movimiento cumple a la vez las categorías, cuentas y fechas elegidas/i),
    ).toBeInTheDocument()

    // 5. Probar distinción por ID entre «Otros · Ingreso» y «Otros · Gasto»
    await user.click(screen.getByRole('button', { name: 'Limpiar categorías' }))
    // «Limpiar categorías» restaura «Todas las categorías» (incluida transferencia) SIN borrar filtros de cuenta ni fecha
    expect(screen.getByLabelText('Desde')).toHaveValue('2026-10-21')
    expect(screen.getAllByText('1 cuenta seleccionada')).toHaveLength(2)
    expect(screen.getByText('Paso a ahorro')).toBeInTheDocument()

    await user.click(screen.getByLabelText('Categorías'))
    await user.click(screen.getByRole('option', { name: 'Otros · Ingreso' }))
    await user.click(screen.getByRole('button', { name: 'Cerrar selector' }))
    expect(screen.getByText('Reembolso recibido')).toBeInTheDocument()
    expect(screen.queryByText('Gasto menor varios')).not.toBeInTheDocument()

    // Restaurar Todas las cuentas y Desde vacío mientras sigue activo el filtro «Otros · Ingreso»:
    // saldos, resúmenes, gastos por categoría, sugerencias y bandeja bancaria NO cambian por el filtro de categorías
    await user.click(screen.getByRole('button', { name: 'Todas' }))
    fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '' } })
    expect(totalBalanceCard.textContent).toBe(initialTotalBalanceText)
    expect(incomeSummaryCard.textContent).toBe(initialIncomeText)
    expect(expenseSummaryCard.textContent).toBe(initialExpenseText)
    expect(categoryExpenseSection.textContent).toBe(initialCategoryExpenseText)
    expect(suggestionsSection.textContent).toBe(initialSuggestionsText)
    expect(inboxSection.textContent).toBe(initialInboxText)
  })
})
