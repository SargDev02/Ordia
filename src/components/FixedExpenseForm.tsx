import { useMemo, useState, type FormEvent } from 'react'
import { getBogotaToday, getCategoryLabel } from '../finance/calculations'
import { useFinance } from '../finance/useFinance'
import type { FixedExpense, FixedExpenseFrequency, FixedExpenseVersion } from '../types/finance'
import { AuthNotice } from './AuthNotice'
import { FormField } from './FormField'

interface Props {
  expense?: FixedExpense
  version?: FixedExpenseVersion
  onCancel: () => void
  onDirtyChange: (dirty: boolean) => void
  onSaved: () => void
}

export function FixedExpenseForm({ expense, version, onCancel, onDirtyChange, onSaved }: Props) {
  const finance = useFinance()
  const today = getBogotaToday()
  const [name, setName] = useState(expense?.name ?? '')
  const [amount, setAmount] = useState(String(version?.expected_amount ?? ''))
  const [categoryId, setCategoryId] = useState(version?.category_id ?? '')
  const [accountId, setAccountId] = useState(version?.suggested_account_id ?? '')
  const [frequency, setFrequency] = useState<FixedExpenseFrequency>(version?.frequency ?? 'monthly')
  const [anchorDate, setAnchorDate] = useState(version?.anchor_date ?? today)
  const [effectiveFrom, setEffectiveFrom] = useState(expense ? today : anchorDate)
  const [notes, setNotes] = useState(expense?.notes ?? '')
  const [requestId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const categories = useMemo(() => finance.categories.filter((item) => item.kind === 'expense' && !item.archived_at)
    .sort((a, b) => getCategoryLabel(a.id, finance.categories).localeCompare(getCategoryLabel(b.id, finance.categories), 'es')), [finance.categories])
  const accounts = finance.accounts.filter((account) => !account.archived_at)
  const selectedCategoryUnavailable = Boolean(version?.category_id && !categories.some((item) => item.id === version.category_id))
  const selectedAccountUnavailable = Boolean(version?.suggested_account_id && !accounts.some((item) => item.id === version.suggested_account_id))

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    const parsedAmount = Number(amount)
    if (!name.trim()) return setError('Escribe un nombre.')
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0 || parsedAmount > 9_000_000_000_000) return setError('El importe debe ser un número entero positivo en pesos.')
    if (!categoryId || !categories.some((item) => item.id === categoryId)) return setError('Selecciona una categoría activa.')
    if (accountId && !accounts.some((item) => item.id === accountId)) return setError('Selecciona una cuenta activa o deja la sugerencia vacía.')
    if (!anchorDate) return setError('Selecciona el primer vencimiento o fecha base.')
    if (!effectiveFrom || effectiveFrom < today) return setError('La fecha efectiva debe ser hoy o posterior.')
    setIsSubmitting(true)
    try {
      const input = { name: name.trim(), expected_amount: parsedAmount, category_id: categoryId, suggested_account_id: accountId || null, frequency, anchor_date: anchorDate, effective_from: expense ? effectiveFrom : anchorDate, notes: notes.trim() || null }
      if (expense) await finance.updateFixedExpense(expense.id, input)
      else await finance.createFixedExpense(requestId, input)
      await finance.refresh()
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar el gasto fijo.')
    } finally { setIsSubmitting(false) }
  }

  return (
    <form aria-busy={isSubmitting} className="bg-white p-6 sm:p-8" onChange={() => onDirtyChange(true)} onSubmit={submit}>
      <div className="mb-6 flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">{expense ? 'Editar configuración' : 'Nueva recurrencia'}</p><h3 className="mt-2 text-2xl font-semibold text-[#173f31]">{expense ? expense.name : 'Gasto fijo'}</h3></div><button className="text-sm font-semibold text-[#66796f]" disabled={isSubmitting} onClick={onCancel} type="button">Cerrar</button></div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormField data-dialog-initial-focus disabled={isSubmitting} id="fixed-name" label="Nombre" maxLength={120} onChange={(event) => setName(event.target.value)} value={name} /></div>
        <FormField disabled={isSubmitting} hint="Pesos enteros, siempre mayor que cero." id="fixed-amount" label="Importe previsto (COP)" min="1" onChange={(event) => setAmount(event.target.value)} step="1" type="number" value={amount} />
        <SelectField id="fixed-category" label="Categoría o subcategoría" value={categoryId} onChange={setCategoryId}><option value="">Selecciona una categoría</option>{categories.map((category) => <option key={category.id} value={category.id}>{getCategoryLabel(category.id, finance.categories)}</option>)}</SelectField>
        <SelectField id="fixed-account" label="Cuenta sugerida (opcional)" value={accountId} onChange={setAccountId}><option value="">Elegir al pagar</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</SelectField>
        <SelectField id="fixed-frequency" label="Frecuencia" value={frequency} onChange={(value) => setFrequency(value as FixedExpenseFrequency)}><option value="monthly">Mensual</option><option value="annual">Anual</option></SelectField>
        <FormField disabled={isSubmitting} id="fixed-anchor" label={expense ? 'Fecha base del calendario' : 'Primer vencimiento'} onChange={(event) => setAnchorDate(event.target.value)} type="date" value={anchorDate} />
        {expense && <FormField disabled={isSubmitting} hint="Los cambios solo afectan obligaciones pendientes desde esta fecha." id="fixed-effective" label="Aplicar cambios desde" min={today} onChange={(event) => setEffectiveFrom(event.target.value)} type="date" value={effectiveFrom} />}
        <div className="sm:col-span-2"><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="fixed-notes">Notas (opcional)</label><textarea className="min-h-24 w-full rounded-2xl border border-[#d6e1d3] px-4 py-3.5" disabled={isSubmitting} id="fixed-notes" maxLength={500} onChange={(event) => setNotes(event.target.value)} value={notes} /></div>
      </div>
      {(selectedCategoryUnavailable || selectedAccountUnavailable) && <div className="mt-5"><AuthNotice tone="error">{`La configuración actual usa ${selectedCategoryUnavailable ? 'una categoría archivada' : 'una cuenta archivada'}. Selecciona una opción activa antes de guardar.`}</AuthNotice></div>}
      {expense && <p className="mt-5 rounded-2xl bg-[#f3f6f0] p-4 text-sm leading-6 text-[#66796f]">Los pagos realizados y las obligaciones vencidas no se reescriben. Los cambios de importe, categoría, cuenta o calendario crean una nueva versión desde la fecha indicada.</p>}
      {error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}
      <div className="mt-6 flex justify-end"><button className="rounded-2xl bg-[#173f31] px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={isSubmitting || categories.length === 0} type="submit">{isSubmitting ? 'Guardando…' : expense ? 'Aplicar cambios futuros' : 'Crear gasto fijo'}</button></div>
    </form>
  )
}

function SelectField({ id, label, value, onChange, children }: { id: string; label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  return <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor={id}>{label}</label><select className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5" id={id} onChange={(event) => onChange(event.target.value)} value={value}>{children}</select></div>
}
