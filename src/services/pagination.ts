// Las consultas de saldos deben incluir todas las páginas, no solo el límite de PostgREST.
export async function fetchAllRows<T, E>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: E | null }>, pageSize = 500) {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const result = await page(from, from + pageSize - 1)
    if (result.error) return { data: null, error: result.error }
    const data = result.data ?? []
    rows.push(...data)
    if (data.length < pageSize) return { data: rows, error: null }
  }
}
