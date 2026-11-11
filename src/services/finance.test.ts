import { beforeEach, expect, it, vi } from 'vitest'
import type { TransactionInput } from '../types/finance'
import { createTransaction, deleteTransaction, updateTransaction } from './finance'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), update: vi.fn(), eq: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.rpc.mockResolvedValue({ error: null })
  mocks.from.mockReturnValue({ update: mocks.update })
  mocks.update.mockReturnValue({ eq: mocks.eq })
  mocks.eq.mockResolvedValue({ error: null })
})
const input: TransactionInput = {
  kind: 'adjustment', account_id: 'account', adjustment_direction: 'decrease', amount: 3000,
  occurred_on: '2026-11-11', category_id: null, destination_account_id: null, description: null,
}

it('crea el ajuste mediante su RPC idempotente sin modificar cuentas ni pagos', async () => {
  await createTransaction('request', input)
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('create_balance_adjustment', {
    p_request_id: 'request', p_account_id: 'account', p_direction: 'decrease', p_amount: 3000,
    p_occurred_on: '2026-11-11', p_description: null,
  })
  expect(mocks.from).not.toHaveBeenCalled()
})

it('conserva la creación anterior y borra la dirección al convertir un ajuste en gasto', async () => {
  const expense: TransactionInput = { ...input, kind: 'expense', category_id: 'category' }
  await createTransaction('request', expense)
  expect(mocks.rpc).toHaveBeenCalledWith('create_financial_transaction', expect.objectContaining({ p_kind: 'expense', p_category_id: 'category' }))
  await updateTransaction('transaction', expense)
  expect(mocks.from).toHaveBeenCalledWith('financial_transactions')
  expect(mocks.update).toHaveBeenCalledWith({ ...expense, adjustment_direction: null })
  expect(mocks.eq).toHaveBeenCalledWith('id', 'transaction')
})

it('edita la misma fila y elimina lógicamente, sin aplicar un segundo delta', async () => {
  await updateTransaction('transaction', { ...input, amount: 2000 })
  expect(mocks.update).toHaveBeenLastCalledWith({ ...input, amount: 2000 })
  await deleteTransaction('transaction')
  expect(mocks.update).toHaveBeenLastCalledWith({ deleted_at: expect.any(String) })
  expect(mocks.eq).toHaveBeenLastCalledWith('id', 'transaction')
  expect(mocks.rpc).not.toHaveBeenCalled()
})

it('propaga el fallo de creación para permitir reintentar desde el formulario', async () => {
  mocks.rpc.mockResolvedValue({ error: { code: '42501' } })
  await expect(createTransaction('request', input)).rejects.toThrow('No pudimos registrar el ajuste')
})
