import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { FinanceProvider } from './FinanceContext'
import { useFinance } from './useFinance'
import { calculateAccountBalance } from './calculations'

const mocks = vi.hoisted(() => ({ user: 'user-a', fetch: vi.fn(), events: [] as Array<{ filter: { event: string; table: string; filter: string }; callback: () => void }> }))
vi.mock('../auth/useAuth', () => ({ useAuth: () => ({ session: { user: { id: mocks.user } } }) }))
vi.mock('../services/finance', async (original) => ({ ...await original<typeof import('../services/finance')>(), fetchFinanceData: mocks.fetch }))
vi.mock('../services/supabase', () => {
  const channel = {
    on: vi.fn((_type, filter, callback) => { mocks.events.push({ filter, callback }); return channel }),
    subscribe: vi.fn(() => channel),
  }
  return { supabase: { channel: () => channel, removeChannel: vi.fn() } }
})

function data(owner = 'user-a', amount = 0) {
  return { accounts: [{ id: 'bank', user_id: owner, name: owner, account_type: 'bank', currency: 'COP', initial_balance: 50000, archived_at: null, created_at: '', updated_at: '' }], categories: [],
    transactions: amount ? [{ id: 'adjust', user_id: owner, kind: 'adjustment', adjustment_direction: 'decrease', account_id: 'bank', amount, destination_account_id: null, category_id: null, occurred_on: '2026-11-18', deleted_at: null }] : [],
    fixedExpenses: [], fixedExpenseVersions: [], fixedExpensePeriods: [], bankInboxAvailable: true, bankEmailAvailable: true, bankEmailAlias: null, bankNotifications: [], cardAccountLinks: [] }
}
function Consumer() {
  const finance = useFinance()
  return <output aria-label="Saldo">{finance.accounts.map(account => `${account.name}: ${calculateAccountBalance(account, finance.transactions)}`)}</output>
}
beforeEach(() => { mocks.user = 'user-a'; mocks.events = []; mocks.fetch.mockReset().mockResolvedValue(data()) })

it('un UPDATE Realtime del usuario refresca el saldo sin recargar la página (evento simulado)', async () => {
  render(<FinanceProvider><Consumer /></FinanceProvider>)
  await waitFor(() => expect(screen.getByLabelText('Saldo')).toHaveTextContent('user-a: 50000'))
  expect(mocks.events.every(event => event.filter.filter === 'user_id=eq.user-a')).toBe(true)
  mocks.fetch.mockResolvedValue(data('user-a', 3000))
  act(() => { mocks.events.find(event => event.filter.table === 'financial_transactions' && event.filter.event === 'UPDATE')!.callback() })
  await waitFor(() => expect(screen.getByLabelText('Saldo')).toHaveTextContent('user-a: 47000'))
})

it('al cambiar de usuario oculta los datos anteriores mientras llega la nueva respuesta', async () => {
  const view = render(<FinanceProvider><Consumer /></FinanceProvider>)
  await waitFor(() => expect(screen.getByLabelText('Saldo')).toHaveTextContent('user-a'))
  let resolve: (value: ReturnType<typeof data>) => void = () => {}
  mocks.fetch.mockImplementation(() => new Promise(done => { resolve = done }))
  mocks.user = 'user-b'
  view.rerender(<FinanceProvider><Consumer /></FinanceProvider>)
  expect(screen.getByLabelText('Saldo')).not.toHaveTextContent('user-a')
  await act(async () => { resolve(data('user-b')) })
  expect(screen.getByLabelText('Saldo')).toHaveTextContent('user-b: 50000')
})
