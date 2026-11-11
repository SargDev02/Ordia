import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { BankNotificationsInbox } from './BankNotificationsInbox'
import { parseMovementNotice } from '../finance/bankNotificationParser'
import { calculateAccountBalance, calculatePeriodSummary } from '../finance/calculations'
import type { BankNotification, FinancialAccount, FinancialCategory, FinancialTransaction } from '../types/finance'

const text = 'Bancolombia: Recibiste una consignacion por $3,000 desde el corresponsal LA UNION HOSPITAL en LA UNION, el 09/06/26 17:04. Si tienes dudas, llamanos: 018000931987. A tu lado siempre.'
const parsed = parseMovementNotice(text)
if (!parsed.success) throw new Error(parsed.error)
const notice: BankNotification = { ...parsed.data, id: 'notice', user_id: 'user', client_request_id: 'request', currency: 'COP', source_channel: 'manual', status: 'pending', resolved_transaction_id: null, resolution_request_id: null, resolved_at: null, dismissed_at: null, created_at: '', updated_at: '' }
const accounts: FinancialAccount[] = [
  { id: 'cash', user_id: 'user', name: 'Efectivo', account_type: 'cash', currency: 'COP', initial_balance: 10000, archived_at: null, created_at: '', updated_at: '' },
  { id: 'bank', user_id: 'user', name: 'Cuenta bancaria', account_type: 'bank', currency: 'COP', initial_balance: 5000, archived_at: null, created_at: '', updated_at: '' },
]
const categories: FinancialCategory[] = [
  { id: 'income', user_id: 'user', kind: 'income', name: 'Otros ingresos', parent_id: null, archived_at: null, created_at: '', updated_at: '' },
  { id: 'expense', user_id: 'user', kind: 'expense', name: 'Otros gastos', parent_id: null, archived_at: null, created_at: '', updated_at: '' },
]
const tx: FinancialTransaction = { id: 'tx', user_id: 'user', client_request_id: 'request-tx', kind: 'income', account_id: 'bank', destination_account_id: null, category_id: 'income', amount: 3000, occurred_on: '2026-06-09', description: 'Consignación de prueba', deleted_at: null, created_at: '', updated_at: '' }
function setup(transactions: FinancialTransaction[] = [], notifications: BankNotification[] = []) {
  const callbacks = { onCreateNotification: vi.fn().mockResolvedValue(notice), onConfirmTransaction: vi.fn().mockResolvedValue(undefined), onConfirmTransfer: vi.fn(), onLinkTransaction: vi.fn().mockResolvedValue(undefined), onDismissNotification: vi.fn().mockResolvedValue(undefined) }
  render(<BankNotificationsInbox notifications={notifications} accounts={accounts} categories={categories} cardAccountLinks={[]} transactions={transactions} {...callbacks} />)
  return callbacks
}

describe('consignaciones recibidas por corresponsal', () => {
  it('pega el aviso, pide solo cuenta bancaria receptora y registra ingreso con categoría de ingreso', async () => {
    const callbacks = setup()
    fireEvent.change(screen.getByLabelText('Texto de la notificación bancaria'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Revisar aviso' }))
    await screen.findByRole('button', { name: 'Registrar ingreso' })
    expect(callbacks.onCreateNotification).toHaveBeenCalledWith(parsed.data)
    expect(callbacks.onConfirmTransaction).not.toHaveBeenCalled()
    expect(callbacks.onConfirmTransfer).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toHaveTextContent('LA UNION HOSPITAL')
    expect(screen.getByRole('dialog')).toHaveTextContent('Municipio: LA UNION')
    expect(screen.queryByRole('button', { name: 'Transferencia entre mis cuentas' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Cuenta de origen')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Cuenta bancaria receptora')).toHaveValue('')
    expect(screen.queryByRole('option', { name: 'Efectivo' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Categoría/ })).toHaveTextContent('Otros ingresos')
    fireEvent.change(screen.getByLabelText('Cuenta bancaria receptora'), { target: { value: 'bank' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y registrar' }))
    await waitFor(() => expect(callbacks.onConfirmTransaction).toHaveBeenCalledWith('notice', expect.any(String), expect.objectContaining({ kind: 'income', account_id: 'bank', category_id: 'income', occurred_on: '2026-06-09', remember_link: false })))
    expect(calculateAccountBalance(accounts[0], [tx])).toBe(10000n)
    expect(calculateAccountBalance(accounts[1], [tx])).toBe(8000n)
    expect(calculatePeriodSummary([tx], categories, { accountIds: new Set(['bank', 'cash']), dateFrom: '2026-06-01', dateTo: '2026-06-30' }).income).toBe(3000n)
  })

  it('Ya lo registré ofrece solo ingresos bancarios y vincula sin crear otro movimiento', async () => {
    const callbacks = setup([tx, { ...tx, id: 'transfer', kind: 'transfer', description: 'Traspaso' }, { ...tx, id: 'cash-income', account_id: 'cash', description: 'Ingreso en efectivo' }], [notice])
    expect(screen.getByText('Consignación recibida')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ya lo registré' }))
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    fireEvent.click(screen.getByRole('radio'))
    fireEvent.click(screen.getByRole('button', { name: 'Vincular a este movimiento' }))
    await waitFor(() => expect(callbacks.onLinkTransaction).toHaveBeenCalledWith('notice', 'tx'))
    expect(callbacks.onConfirmTransaction).not.toHaveBeenCalled()
    expect(callbacks.onConfirmTransfer).not.toHaveBeenCalled()
  })

  it('descartar conserva los movimientos existentes', async () => {
    const callbacks = setup([tx], [notice])
    fireEvent.click(screen.getByRole('button', { name: 'Revisar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }))
    fireEvent.click(screen.getByRole('button', { name: /Confirmar descarte/ }))
    await waitFor(() => expect(callbacks.onDismissNotification).toHaveBeenCalledWith('notice'))
    expect(callbacks.onConfirmTransaction).not.toHaveBeenCalled()
  })
})
