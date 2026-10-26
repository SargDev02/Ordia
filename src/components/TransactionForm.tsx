import { useMemo, useState, type FormEvent } from 'react'
import { useFinance } from '../finance/useFinance'
import { getBogotaToday, getCategoryLabel } from '../finance/calculations'
import type { FinancialTransaction, TransactionKind } from '../types/finance'
import { AuthNotice } from './AuthNotice'
import { FormField } from './FormField'

interface TransactionFormProps {
  initialKind?: TransactionKind
  transaction?: FinancialTransaction
  onCancel: () => void
  onDirtyChange: (isDirty: boolean) => void
  onSaved: () => void
}

export function TransactionForm({ initialKind = 'expense', transaction, onCancel, onDirtyChange, onSaved }: TransactionFormProps) {
  const { accounts, categories, createTransaction, updateTransaction } = useFinance()
  const [kind, setKind] = useState<TransactionKind>(transaction?.kind ?? initialKind)
  const [accountId, setAccountId] = useState(transaction?.account_id ?? '')
  const [destinationId, setDestinationId] = useState(transaction?.destination_account_id ?? '')
  const [amount, setAmount] = useState(String(transaction?.amount ?? ''))
  const [date, setDate] = useState(transaction?.occurred_on ?? getBogotaToday())
  const [categoryId, setCategoryId] = useState(transaction?.category_id
    ?? categories.find((category) => category.kind === initialKind && !category.archived_at)?.id
    ?? '')
  const [description, setDescription] = useState(transaction?.description ?? '')
  const [requestId] = useState(() => crypto.randomUUID())
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const availableAccounts = useMemo(() => accounts.filter((account) =>
    !account.archived_at || account.id === transaction?.account_id || account.id === transaction?.destination_account_id,
  ), [accounts, transaction])
  const categoryOptions = useMemo(() => categories.filter((category) =>
    category.kind === kind && (!category.archived_at || category.id === transaction?.category_id),
  ).sort((first, second) => getCategoryLabel(first.id, categories).localeCompare(getCategoryLabel(second.id, categories), 'es')), [categories, kind, transaction])

  function markDirty() {
    onDirtyChange(true)
  }

  function handleKindChange(nextKind: TransactionKind) {
    setKind(nextKind)
    setCategoryId(nextKind === 'transfer' ? '' : categories.find((category) => category.kind === nextKind && !category.archived_at)?.id ?? '')
    if (nextKind !== 'transfer') setDestinationId('')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const parsedAmount = Number(amount)
    if (!accountId) return setError('Selecciona una cuenta.')
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0 || parsedAmount > 9_000_000_000_000) return setError('El importe debe ser un número entero positivo en pesos.')
    if (!date) return setError('Selecciona una fecha.')
    if (kind === 'transfer' && !destinationId) return setError('Selecciona la cuenta de destino.')
    if (kind === 'transfer' && destinationId === accountId) return setError('La cuenta de origen y destino deben ser diferentes.')
    if (kind !== 'transfer' && !categoryId) return setError('Selecciona una categoría activa.')

    setIsSubmitting(true)
    try {
      const input = {
        account_id: accountId,
        amount: parsedAmount,
        category_id: kind === 'transfer' ? null : categoryId,
        description: description.trim() || null,
        destination_account_id: kind === 'transfer' ? destinationId : null,
        kind,
        occurred_on: date,
      }
      if (transaction) await updateTransaction(transaction.id, input)
      else await createTransaction(requestId, input)
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar el movimiento.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form className="bg-white p-6 sm:p-8" onChange={markDirty} onSubmit={handleSubmit} aria-busy={isSubmitting}>
      <div className="mb-6 flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">{transaction ? 'Editar movimiento' : 'Nuevo movimiento'}</p><h3 className="mt-2 text-2xl font-semibold text-[#173f31]">{kind === 'transfer' ? 'Transferencia' : kind === 'income' ? 'Ingreso' : 'Gasto'}</h3></div><button className="text-sm font-semibold text-[#66796f]" disabled={isSubmitting} onClick={onCancel} type="button">Cerrar</button></div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2"><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="transaction-kind">Tipo</label><select className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5" data-dialog-initial-focus id="transaction-kind" onChange={(event) => handleKindChange(event.target.value as TransactionKind)} value={kind}><option value="expense">Gasto</option><option value="income">Ingreso</option><option value="transfer">Transferencia</option></select></div>
        <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="transaction-account">{kind === 'transfer' ? 'Cuenta de origen' : 'Cuenta'}</label><select className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5" id="transaction-account" onChange={(event) => setAccountId(event.target.value)} value={accountId}><option value="">Selecciona una cuenta</option>{availableAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.archived_at ? ' (archivada)' : ''}</option>)}</select></div>
        {kind === 'transfer' && <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="transaction-destination">Cuenta de destino</label><select className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5" id="transaction-destination" onChange={(event) => setDestinationId(event.target.value)} value={destinationId}><option value="">Selecciona una cuenta</option>{availableAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.archived_at ? ' (archivada)' : ''}</option>)}</select></div>}
        <FormField disabled={isSubmitting} hint="Pesos enteros, siempre mayor que cero." id="transaction-amount" label="Importe" min="1" onChange={(event) => setAmount(event.target.value)} step="1" type="number" value={amount} />
        <FormField disabled={isSubmitting} id="transaction-date" label="Fecha" onChange={(event) => setDate(event.target.value)} type="date" value={date} />
        {kind !== 'transfer' && <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="transaction-category">Categoría</label><select className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5" id="transaction-category" onChange={(event) => setCategoryId(event.target.value)} value={categoryId}><option value="">Selecciona una categoría</option>{categoryOptions.map((category) => <option key={category.id} value={category.id}>{getCategoryLabel(category.id, categories)}{category.archived_at ? ' (archivada)' : ''}</option>)}</select>{categoryOptions.length === 0 && <p className="mt-2 text-sm text-[#8b554d]">No hay categorías activas de este tipo. Crea una desde “Administrar categorías”.</p>}</div>}
        <div className={kind === 'transfer' ? 'sm:col-span-2' : ''}><FormField disabled={isSubmitting} id="transaction-description" label="Descripción (opcional)" maxLength={240} onChange={(event) => setDescription(event.target.value)} value={description} /></div>
      </div>
      {error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}
      <div className="mt-6 flex justify-end"><button className="rounded-2xl bg-[#173f31] px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={isSubmitting || availableAccounts.length === 0} type="submit">{isSubmitting ? 'Guardando…' : 'Guardar movimiento'}</button></div>
    </form>
  )
}
