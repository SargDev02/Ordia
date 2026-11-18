import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { BankNotificationsInbox } from './BankNotificationsInbox'
import type { BankNotification, FinancialAccount, FinancialCategory, FixedExpense, FixedExpensePaymentInput, FixedExpensePeriod } from '../types/finance'

vi.mock('../finance/useFinance', () => ({ useFinance: () => ({ accounts, categories, refresh: vi.fn().mockResolvedValue(undefined) }) }))
const accounts: FinancialAccount[] = [{ id: 'bank', user_id: 'owner', name: 'Banco de prueba', account_type: 'bank', currency: 'COP', initial_balance: 50000, archived_at: null, created_at: '', updated_at: '' }]
const categories: FinancialCategory[] = [{ id: 'category', user_id: 'owner', kind: 'expense', name: 'Servicios', parent_id: null, archived_at: null, created_at: '', updated_at: '' }]
const expense: FixedExpense = { id: 'fixed', user_id: 'owner', client_request_id: 'fixed-request', name: 'Internet de prueba', notes: null, status: 'active', paused_at: null, deleted_at: null, created_at: '', updated_at: '' }
const period: FixedExpensePeriod = { id: 'period', user_id: 'owner', fixed_expense_id: 'fixed', version_id: 'version', due_date: '2026-11-18', expected_amount: 5000, currency: 'COP', category_id: 'category', suggested_account_id: 'bank', transaction_id: null, payment_request_id: null, paid_amount: null, paid_on: null, paid_account_id: null, paid_category_id: null, paid_at: null, cancelled_at: null, cancellation_reason: null, created_at: '', updated_at: '' }
const notice: BankNotification = { id: 'notice', user_id: 'owner', client_request_id: 'request', bank_name: 'Bancolombia', source_channel: 'gmail', notification_type: 'purchase', amount: 3000, currency: 'COP', occurred_on: '2026-11-17', occurred_time: '10:00', merchant: 'EMPRESA DE PRUEBA', account_last_digits: null, card_last_digits: null, card_type: null, counterparty_name: null, counterparty_account_last_digits: null, status: 'pending', resolved_transaction_id: null, resolution_request_id: null, dismissed_at: null, resolved_at: null, created_at: '', updated_at: '' }

function inbox(onPay: (noticeId: string, periodId: string, requestId: string, input: FixedExpensePaymentInput) => Promise<void>, notification = notice) {
  return <MemoryRouter><BankNotificationsInbox accounts={accounts} categories={categories} cardAccountLinks={[]}
    transactions={[]} notifications={[notification]} fixedExpenses={[expense]} fixedExpensePeriods={[period, { ...period, id: 'cancelled', cancelled_at: '2026-11-18', due_date: '2026-12-18' }]}
    onPayFixedExpense={onPay} onCreateNotification={vi.fn()} onConfirmTransaction={vi.fn()} onConfirmTransfer={vi.fn()} onLinkTransaction={vi.fn()} onDismissNotification={vi.fn()} /></MemoryRouter>
}

it('busca la obligación, confirma datos reales y conserva el request al reintentar un fallo', async () => {
  const user = userEvent.setup(); const onPay = vi.fn().mockRejectedValueOnce(new Error('Sin conexión')).mockResolvedValue(undefined)
  render(inbox(onPay)); await user.click(screen.getByRole('button', { name: /^Revisar$/ }))
  await user.click(screen.getByRole('button', { name: 'Registrar pago de gasto fijo' }))
  await user.type(screen.getByLabelText('Buscar gasto fijo u obligación'), 'internet')
  expect(screen.getByRole('option', { name: /Internet.*2026-11.*5.000/ })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /2026-12-18/ })).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('Obligación que se pagó'), 'period')
  await user.selectOptions(screen.getByLabelText('Cuenta'), 'bank')
  expect(screen.getByLabelText('Importe pagado (COP)')).toHaveValue('3.000')
  expect(screen.getByLabelText('Fecha real del pago')).toHaveValue('2026-11-17')
  await user.click(screen.getByRole('button', { name: /^Registrar pago$/ }))
  expect(await screen.findByText('Confirma la cuenta, el importe y la fecha real del pago.')).toBeInTheDocument()
  expect(onPay).not.toHaveBeenCalled()
  await user.click(screen.getByRole('checkbox', { name: /Confirmo la cuenta/ }))
  await user.click(screen.getByRole('button', { name: /^Registrar pago$/ }))
  expect(await screen.findByText('Sin conexión')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /^Registrar pago$/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(onPay).toHaveBeenCalledTimes(2)
  expect(onPay.mock.calls[0]).toEqual(onPay.mock.calls[1])
  expect(onPay.mock.calls[0]).toEqual(['notice', 'period', expect.any(String), { account_id: 'bank', category_id: 'category', paid_on: '2026-11-17', amount: 3000 }])
})

it.each(['transfer_received', 'cash_deposit_received'] as const)('no ofrece pago fijo para %s', (notification_type) => {
  render(inbox(vi.fn(), { ...notice, notification_type }))
  fireEvent.click(screen.getByRole('button', { name: /^Revisar$/ }))
  expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Registrar pago de gasto fijo' })).not.toBeInTheDocument()
})
