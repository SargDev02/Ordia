import { expect, it, vi } from 'vitest'
import { fetchAllRows } from './pagination'

it('incluye todas las páginas y usa rangos inclusivos sin duplicar filas', async () => {
  const items = Array.from({ length: 1203 }, (_, id) => ({ id, amount: 1000 }))
  const page = vi.fn(async (from: number, to: number) => ({ data: items.slice(from, to + 1), error: null }))
  const result = await fetchAllRows(page)
  expect(result.data).toEqual(items)
  expect(result.data?.reduce((sum, row) => sum + BigInt(row.amount), 0n)).toBe(1203000n)
  expect(page.mock.calls).toEqual([[0, 499], [500, 999], [1000, 1499]])
})

it('un fallo de otra página no publica un saldo parcial', async () => {
  const error = { code: 'network' }
  const result = await fetchAllRows(async (from) => from ? { data: null, error } : { data: [1, 2], error: null }, 2)
  expect(result).toEqual({ data: null, error })
})
