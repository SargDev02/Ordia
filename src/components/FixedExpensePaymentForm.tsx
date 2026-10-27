import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { getBogotaToday, getCategoryLabel } from '../finance/calculations'
import { useFinance } from '../finance/useFinance'
import type { FixedExpense, FixedExpensePeriod } from '../types/finance'
import { AuthNotice } from './AuthNotice'
import { FormField } from './FormField'

export function FixedExpensePaymentForm({ expense, period, onCancel, onDirtyChange, onSaved }: { expense: FixedExpense; period: FixedExpensePeriod; onCancel: () => void; onDirtyChange: (dirty: boolean) => void; onSaved: () => void }) {
  const finance = useFinance()
  const accounts = finance.accounts.filter((account) => !account.archived_at)
  const categories = useMemo(() => finance.categories.filter((category) => category.kind === 'expense' && !category.archived_at)
    .sort((a, b) => getCategoryLabel(a.id, finance.categories).localeCompare(getCategoryLabel(b.id, finance.categories), 'es')), [finance.categories])
  const [accountId, setAccountId] = useState(accounts.some((item) => item.id === period.suggested_account_id) ? period.suggested_account_id ?? '' : '')
  const [categoryId, setCategoryId] = useState(categories.some((item) => item.id === period.category_id) ? period.category_id : '')
  const [amount, setAmount] = useState(String(period.expected_amount))
  const [paidOn, setPaidOn] = useState(getBogotaToday())
  const [requestId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    const parsed = Number(amount)
    if (!accountId) return setError('Selecciona una cuenta activa.')
    if (!categoryId) return setError('Selecciona una categoría activa.')
    if (!paidOn) return setError('Selecciona la fecha real del pago.')
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 9_000_000_000_000) return setError('El importe debe ser un número entero positivo en pesos.')
    setIsSubmitting(true)
    try {
      await finance.payFixedExpensePeriod(period.id, requestId, { account_id: accountId, category_id: categoryId, paid_on: paidOn, amount: parsed })
      await finance.refresh()
      onSaved()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos registrar el pago.') }
    finally { setIsSubmitting(false) }
  }

  return <form aria-busy={isSubmitting} className="bg-white p-6 sm:p-8" onChange={() => onDirtyChange(true)} onSubmit={submit}>
    <div className="mb-6 flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">Marcar como pagado</p><h3 className="mt-2 text-2xl font-semibold text-[#173f31]">{expense.name}</h3><p className="mt-1 text-sm text-[#66796f]">Obligación del {period.due_date}</p></div><button className="text-sm font-semibold text-[#66796f]" disabled={isSubmitting} onClick={onCancel} type="button">Cerrar</button></div>
    <div className="grid gap-5 sm:grid-cols-2">
      <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="payment-account">Cuenta</label><select className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5" data-dialog-initial-focus id="payment-account" onChange={(event) => setAccountId(event.target.value)} value={accountId}><option value="">Selecciona una cuenta</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></div>
      <FormField disabled={isSubmitting} id="payment-date" label="Fecha real del pago" onChange={(event) => setPaidOn(event.target.value)} type="date" value={paidOn} />
      <FormField disabled={isSubmitting} hint={`Previsto: ${period.expected_amount.toLocaleString('es-CO')} COP. Puede ser diferente.`} id="payment-amount" label="Importe pagado (COP)" min="1" onChange={(event) => setAmount(event.target.value)} step="1" type="number" value={amount} />
      <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="payment-category">Categoría</label><select className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5" id="payment-category" onChange={(event) => setCategoryId(event.target.value)} value={categoryId}><option value="">Selecciona una categoría</option>{categories.map((category) => <option key={category.id} value={category.id}>{getCategoryLabel(category.id, finance.categories)}</option>)}</select></div>
    </div>
    {accounts.length === 0 && <div className="mt-5"><AuthNotice tone="error">Necesitas una cuenta activa para registrar el pago.</AuthNotice><Link className="mt-3 inline-flex text-sm font-semibold text-[#346a52] underline underline-offset-2" to="/">Ir al resumen para crear una cuenta</Link></div>}
    {(!categories.some((item) => item.id === period.category_id) || (period.suggested_account_id && !accounts.some((item) => item.id === period.suggested_account_id))) && <div className="mt-5"><AuthNotice tone="error">La categoría o cuenta sugerida fue archivada. Selecciona una opción activa para continuar.</AuthNotice></div>}
    {error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}
    <div className="mt-6 flex justify-end"><button className="rounded-2xl bg-[#173f31] px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={isSubmitting || accounts.length === 0 || categories.length === 0} type="submit">{isSubmitting ? 'Registrando…' : 'Registrar pago'}</button></div>
  </form>
}
