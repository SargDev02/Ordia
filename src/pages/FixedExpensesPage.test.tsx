import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinancialAccount, FinancialCategory, FixedExpense, FixedExpensePeriod, FixedExpenseVersion } from '../types/finance'
import { FixedExpensesPage } from './FixedExpensesPage'

const mocks = vi.hoisted(() => ({
  pay: vi.fn(), pause: vi.fn(), reactivate: vi.fn(), remove: vi.fn(), undo: vi.fn(), refresh: vi.fn(), create: vi.fn(), update: vi.fn(), signOut: vi.fn(),
  data: { accounts: [] as FinancialAccount[], categories: [] as FinancialCategory[], fixedExpenses: [] as FixedExpense[], fixedExpensePeriods: [] as FixedExpensePeriod[], fixedExpenseVersions: [] as FixedExpenseVersion[] },
}))

vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ session: { user: { email: 'usuario@ordia.test' } }, signOut: mocks.signOut }) }))
vi.mock('../finance/useFinance', () => ({ useFinance: () => ({ ...mocks.data, error: '', isLoading: false, realtimeStatus: 'connected', transactions: [], createFixedExpense: mocks.create, updateFixedExpense: mocks.update, payFixedExpensePeriod: mocks.pay, pauseFixedExpense: mocks.pause, reactivateFixedExpense: mocks.reactivate, removeFixedExpense: mocks.remove, undoFixedExpensePayment: mocks.undo, refresh: mocks.refresh }) }))
vi.mock('../finance/calculations', async () => ({
  ...await vi.importActual<typeof import('../finance/calculations')>('../finance/calculations'),
  getBogotaToday: () => '2026-10-26',
}))

const account: FinancialAccount = { account_type: 'bank', archived_at: null, created_at: '', currency: 'COP', id: 'account-a', initial_balance: 0, name: 'Principal', updated_at: '', user_id: 'user-a' }
const category: FinancialCategory = { archived_at: null, created_at: '', id: 'category-a', kind: 'expense', name: 'Servicios', parent_id: null, updated_at: '', user_id: 'user-a' }
const expense: FixedExpense = { client_request_id: 'request-a', created_at: '', deleted_at: null, id: 'fixed-a', name: 'Internet', notes: null, paused_at: null, status: 'active', updated_at: '', user_id: 'user-a' }
const version: FixedExpenseVersion = { anchor_date: '2026-10-30', category_id: category.id, created_at: '', currency: 'COP', effective_from: '2026-10-30', expected_amount: 90000, fixed_expense_id: expense.id, frequency: 'monthly', id: 'version-a', suggested_account_id: account.id, superseded_at: null, user_id: 'user-a' }
const period: FixedExpensePeriod = { cancellation_reason: null, cancelled_at: null, category_id: category.id, created_at: '', currency: 'COP', due_date: '2026-10-30', expected_amount: 90000, fixed_expense_id: expense.id, id: 'period-a', paid_account_id: null, paid_category_id: null, paid_amount: null, paid_at: null, paid_on: null, payment_request_id: null, suggested_account_id: account.id, transaction_id: null, updated_at: '', user_id: 'user-a', version_id: version.id }

function fixedPeriod(id: string, dueDate: string, overrides: Partial<FixedExpensePeriod> = {}): FixedExpensePeriod {
  return { ...period, due_date: dueDate, id, ...overrides }
}

function renderPage() { return render(<MemoryRouter initialEntries={['/gastos-fijos']}><FixedExpensesPage /></MemoryRouter>) }

describe('gastos fijos', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mocks.data, { accounts: [account], categories: [category], fixedExpenses: [expense], fixedExpensePeriods: [period], fixedExpenseVersions: [version] })
    mocks.pay.mockResolvedValue(undefined); mocks.pause.mockResolvedValue(undefined); mocks.refresh.mockResolvedValue(undefined)
  })

  it('separa obligaciones pendientes de pagos ya realizados', () => {
    renderPage()
    expect(screen.getByText('Pendientes del mes · 1')).toBeInTheDocument()
    expect(screen.getByText('Próximo mes · 0')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Marcar como pagado' })).toBeInTheDocument()
  })

  it('muestra una sola fila por gasto y avisa cuántos pagos adicionales existen', () => {
    mocks.data.fixedExpensePeriods = [
      fixedPeriod('oldest', '2000-01-30'),
      fixedPeriod('second', '2000-02-28'),
      fixedPeriod('current', '2026-10-30'),
      fixedPeriod('next-month', '2026-11-30'),
    ]
    renderPage()
    const obligations = screen.getByRole('heading', { name: 'Obligaciones' }).closest('section') as HTMLElement
    expect(within(obligations).getAllByRole('button', { name: 'Marcar como pagado' })).toHaveLength(1)
    expect(within(obligations).getByText('Vence 2000-01-30')).toBeInTheDocument()
    expect(within(obligations).getByText('2 pagos adicionales pendientes · 2 vencidos en total')).toBeInTheDocument()
  })

  it('presenta el siguiente período después de pagar el primero', async () => {
    const user = userEvent.setup()
    const first = fixedPeriod('first', '2000-01-30')
    const second = fixedPeriod('second', '2000-02-28')
    mocks.data.fixedExpensePeriods = [first, second]
    mocks.pay.mockImplementation(async () => {
      mocks.data.fixedExpensePeriods = [
        { ...first, paid_account_id: account.id, paid_category_id: category.id, paid_amount: first.expected_amount, paid_at: '2026-10-26T00:00:00Z', paid_on: '2026-10-26', payment_request_id: 'payment-a', transaction_id: 'movement-a' },
        second,
      ]
    })
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Marcar como pagado' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Registrar pago' })).getByRole('button', { name: 'Registrar pago' }))
    await waitFor(() => expect(screen.getByText('Vence 2000-02-28')).toBeInTheDocument())
    expect(screen.queryByText('Vence 2000-01-30')).not.toBeInTheDocument()
    expect(mocks.pay).toHaveBeenCalledTimes(1)
  })

  it('explica y calcula los totales mensuales sin mezclar el mes siguiente', () => {
    mocks.data.fixedExpensePeriods = [
      fixedPeriod('previous', '2026-09-30', { expected_amount: 80000 }),
      fixedPeriod('earlier', '2026-10-10', { expected_amount: 90000 }),
      fixedPeriod('today', '2026-10-26', { expected_amount: 100000 }),
      fixedPeriod('later', '2026-10-30', { expected_amount: 110000 }),
      fixedPeriod('next', '2026-11-30', { expected_amount: 120000 }),
      fixedPeriod('paid', '2026-09-15', { expected_amount: 60000, paid_account_id: account.id, paid_category_id: category.id, paid_amount: 70000, paid_at: '2026-10-20T00:00:00Z', paid_on: '2026-10-20', payment_request_id: 'payment-paid', transaction_id: 'movement-paid' }),
    ]
    renderPage()
    const pendingCard = screen.getByText('Pendientes del mes · 3').closest('article') as HTMLElement
    const overdueCard = screen.getByText('Vencidos · 2').closest('article') as HTMLElement
    const paidCard = screen.getByText('Pagados este mes · 1').closest('article') as HTMLElement
    const upcomingCard = screen.getByText('Próximo mes · 1').closest('article') as HTMLElement
    expect(pendingCard).toHaveTextContent('300.000')
    expect(overdueCard).toHaveTextContent('170.000')
    expect(paidCard).toHaveTextContent('70.000')
    expect(paidCard).toHaveTextContent('fecha real de pago')
    expect(upcomingCard).toHaveTextContent('120.000')
    expect(upcomingCard).toHaveTextContent('no son pendientes del mes actual')
  })

  it('al pagar la obligación del mes no promueve una del mes siguiente', async () => {
    const user = userEvent.setup()
    const current = fixedPeriod('current', '2026-10-30')
    const next = fixedPeriod('next', '2026-11-30')
    mocks.data.fixedExpensePeriods = [current, next]
    mocks.pay.mockImplementation(async () => {
      mocks.data.fixedExpensePeriods = [
        { ...current, paid_account_id: account.id, paid_category_id: category.id, paid_amount: current.expected_amount, paid_at: '2026-10-26T00:00:00Z', paid_on: '2026-10-26', payment_request_id: 'payment-current', transaction_id: 'movement-current' },
        next,
      ]
    })
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Marcar como pagado' }))
    await user.click(within(screen.getByRole('dialog', { name: 'Registrar pago' })).getByRole('button', { name: 'Registrar pago' }))
    await waitFor(() => expect(screen.getByText('No hay obligaciones en este estado')).toBeInTheDocument())
    expect(screen.queryByText('Vence 2026-11-30')).not.toBeInTheDocument()
    expect(screen.getByText('Próximo mes · 1')).toBeInTheDocument()
  })

  it('mantiene como pagado un vencimiento del mes abonado anticipadamente', async () => {
    const user = userEvent.setup()
    mocks.data.fixedExpensePeriods = [fixedPeriod('prepaid', '2026-10-30', { paid_account_id: account.id, paid_category_id: category.id, paid_amount: 85000, paid_at: '2026-09-20T00:00:00Z', paid_on: '2026-09-20', payment_request_id: 'payment-prepaid', transaction_id: 'movement-prepaid' })]
    renderPage()
    expect(screen.getByText('Pendientes del mes · 0')).toBeInTheDocument()
    expect(screen.getByText('Pagados este mes · 0')).toBeInTheDocument()
    expect(screen.getByText(/1 obligación de este mes fue pagada anticipadamente/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Ver detalle' }))
    expect(within(screen.getByRole('dialog', { name: 'Detalle de Internet' })).getByText('Pagado el 2026-09-20')).toBeInTheDocument()
  })

  it('mantiene vencimientos futuros e historial pagado en el detalle', async () => {
    const user = userEvent.setup()
    mocks.data.fixedExpensePeriods = [
      fixedPeriod('paid', '2000-01-30', { paid_account_id: account.id, paid_category_id: category.id, paid_amount: 85000, paid_at: '2026-10-20T00:00:00Z', paid_on: '2026-10-20', payment_request_id: 'payment-a', transaction_id: 'movement-a' }),
      fixedPeriod('next', '2026-10-30'),
      fixedPeriod('later', '2026-11-30'),
    ]
    renderPage()
    const obligations = screen.getByRole('heading', { name: 'Obligaciones' }).closest('section') as HTMLElement
    await user.click(within(obligations).getByRole('button', { name: 'Ver detalle' }))
    const detail = screen.getByRole('dialog', { name: 'Detalle de Internet' })
    expect(within(detail).getByRole('heading', { name: 'Próximos vencimientos (2)' })).toBeInTheDocument()
    expect(within(detail).getByText('Vence 2026-10-30')).toBeInTheDocument()
    expect(within(detail).getByText('Vence 2026-11-30')).toBeInTheDocument()
    expect(within(detail).getByRole('heading', { name: 'Historial de pagos (1)' })).toBeInTheDocument()
    expect(within(detail).getByText('Pagado el 2026-10-20')).toBeInTheDocument()
  })

  it('mantiene visible una deuda vencida de un gasto dado de baja', async () => {
    const user = userEvent.setup()
    mocks.data.fixedExpenses = [{ ...expense, deleted_at: '2026-10-20T00:00:00Z', status: 'deleted' }]
    mocks.data.fixedExpensePeriods = [fixedPeriod('overdue', '2000-01-30')]
    renderPage()
    const obligations = screen.getByRole('heading', { name: 'Obligaciones' }).closest('section') as HTMLElement
    expect(within(obligations).getByText('Vence 2000-01-30')).toBeInTheDocument()
    expect(within(obligations).getByRole('button', { name: 'Marcar como pagado' })).toBeInTheDocument()
    await user.click(within(obligations).getByRole('button', { name: 'Ver detalle' }))
    expect(within(screen.getByRole('dialog', { name: 'Detalle de Internet' })).getByText(/Dado de baja/)).toBeInTheDocument()
  })

  it('precarga el pago y lo registra con el flujo dedicado', async () => {
    const user = userEvent.setup(); renderPage()
    await user.click(screen.getByRole('button', { name: 'Marcar como pagado' }))
    const dialog = screen.getByRole('dialog', { name: 'Registrar pago' })
    expect(within(dialog).getByLabelText('Cuenta')).toHaveValue(account.id)
    expect(within(dialog).getByLabelText('Importe pagado (COP)')).toHaveValue(90000)
    await user.click(within(dialog).getByRole('button', { name: 'Registrar pago' }))
    await waitFor(() => expect(mocks.pay).toHaveBeenCalledWith(period.id, expect.any(String), expect.objectContaining({ account_id: account.id, amount: 90000, category_id: category.id })))
    expect(screen.queryByRole('dialog', { name: 'Registrar pago' })).not.toBeInTheDocument()
  })

  it('conserva cambios del formulario si se rechaza descartarlos', async () => {
    const user = userEvent.setup(); const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false); renderPage()
    await user.click(screen.getByRole('button', { name: 'Nuevo gasto fijo' }))
    const dialog = screen.getByRole('dialog', { name: 'Nuevo gasto fijo' })
    await user.type(within(dialog).getByLabelText('Nombre'), 'Arriendo')
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
    expect(confirm).toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Nuevo gasto fijo' })).toBeInTheDocument()
  })

  it('confirma la pausa y usa la operación dedicada', async () => {
    const user = userEvent.setup(); renderPage()
    await user.click(screen.getByRole('button', { name: 'Pausar' }))
    const dialog = screen.getByRole('dialog', { name: '¿Pausar este gasto fijo?' })
    await user.click(within(dialog).getByRole('button', { name: 'Pausar' }))
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith(expense.id))
  })
})
