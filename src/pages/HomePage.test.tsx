import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinancialAccount, FinancialCategory } from '../types/finance'
import { HomePage } from './HomePage'

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
    error: '',
    isLoading: false,
    realtimeStatus: 'connected' as const,
    transactions: [],
  },
  archiveCategory: vi.fn(),
  createCategory: vi.fn(),
  renameCategory: vi.fn(),
}))

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
    mocks.createTransaction.mockResolvedValue(undefined)
    mocks.createCategory.mockResolvedValue(undefined)
  })

  it('abre un ingreso preseleccionado y devuelve el foco al cerrar', async () => {
    const user = userEvent.setup()
    render(<HomePage />)
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
    render(<HomePage />)

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
    render(<HomePage />)

    await user.click(screen.getByRole('button', { name: 'Transferir' }))
    const unavailable = screen.getByRole('dialog', { name: 'Operación no disponible' })
    expect(within(unavailable).getByText('Necesitas dos cuentas activas')).toBeInTheDocument()

    await user.click(within(unavailable).getByRole('button', { name: 'Crear una cuenta' }))
    expect(screen.getByRole('dialog', { name: 'Nueva cuenta' })).toBeInTheDocument()
    expect(screen.getByLabelText('Nombre')).toHaveFocus()
  })

  it('muestra validación dentro del formulario y lo cierra después de guardar', async () => {
    const user = userEvent.setup()
    render(<HomePage />)

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
    render(<HomePage />)
    await user.click(screen.getByRole('button', { name: 'Limpiar' }))
    expect(screen.getByText('No hay cuentas seleccionadas')).toBeInTheDocument()
    expect(screen.getAllByText('Ninguna cuenta seleccionada')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Todas' }))
    expect(screen.getAllByText('Todas las cuentas (2)')).toHaveLength(2)
  })

  it('abre la administración y crea una subcategoría del tipo elegido', async () => {
    const user = userEvent.setup()
    render(<HomePage />)
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
})
