import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { FinancialAccount, FinancialCategory, FinancialTransaction, FixedExpense, FixedExpensePeriod } from '../types/finance'
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
  finance: {
    accounts: [] as FinancialAccount[],
    categories: [] as FinancialCategory[],
    fixedExpensePeriods: [] as FixedExpensePeriod[],
    fixedExpenses: [] as FixedExpense[],
    fixedExpenseVersions: [],
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

  it('abre la administración y crea una subcategoría del tipo elegido', async () => {
    const user = userEvent.setup()
    renderHome()
    await user.click(screen.getByRole('button', { name: 'Administrar categorías' }))
    const dialog = screen.getByRole('dialog', { name: 'Administrar categorías' })
    await user.selectOptions(within(dialog).getByLabelText('Nivel'), 'expense-category')
    await user.type(within(dialog).getByLabelText('Nombre'), 'Restaurantes')
    await user.click(within(dialog).getByRole('button', { name: 'Crear categoría' }))
    await waitFor(() => expect(mocks.createCategory).toHaveBeenCalledWith({
      kind: 'expense',
      name: 'Restaurantes',
      parent_id: 'expense-category',
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
})
