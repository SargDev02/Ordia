import { useState, type FormEvent } from 'react'
import { useFinance } from '../finance/useFinance'
import type { AccountType, FinancialAccount } from '../types/finance'
import { AuthNotice } from './AuthNotice'
import { FormField } from './FormField'

interface AccountFormProps {
  account?: FinancialAccount
  onCancel: () => void
  onDirtyChange: (isDirty: boolean) => void
  onSaved: () => void
}

export function AccountForm({ account, onCancel, onDirtyChange, onSaved }: AccountFormProps) {
  const { createAccount, updateAccount } = useFinance()
  const [name, setName] = useState(account?.name ?? '')
  const [accountType, setAccountType] = useState<AccountType>(account?.account_type ?? 'bank')
  const [initialBalance, setInitialBalance] = useState(String(account?.initial_balance ?? 0))
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  function markDirty() {
    onDirtyChange(true)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const amount = Number(initialBalance)
    if (!name.trim()) return setError('Escribe un nombre para la cuenta.')
    if (!Number.isSafeInteger(amount) || Math.abs(amount) > 9_000_000_000_000) {
      return setError('El saldo inicial debe ser un número entero válido en pesos.')
    }

    setIsSubmitting(true)
    try {
      const input = { name: name.trim(), account_type: accountType, initial_balance: amount }
      if (account) await updateAccount(account.id, input)
      else await createAccount(input)
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar la cuenta.')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form className="bg-white p-6 sm:p-8" onChange={markDirty} onSubmit={handleSubmit} aria-busy={isSubmitting}>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">{account ? 'Editar cuenta' : 'Nueva cuenta'}</p><h3 className="mt-2 text-2xl font-semibold text-[#173f31]">Datos de la cuenta</h3></div>
        <button className="text-sm font-semibold text-[#66796f] hover:text-[#173f31]" disabled={isSubmitting} onClick={onCancel} type="button">Cerrar</button>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2"><FormField data-dialog-initial-focus disabled={isSubmitting} id="account-name" label="Nombre" maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Ej. Cuenta principal" value={name} /></div>
        <div>
          <label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="account-type">Tipo</label>
          <select className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5 text-[#173f31]" disabled={isSubmitting} id="account-type" onChange={(event) => setAccountType(event.target.value as AccountType)} value={accountType}>
            <option value="cash">Efectivo</option><option value="bank">Banco</option><option value="wallet">Billetera</option>
          </select>
        </div>
        <FormField disabled id="account-currency" label="Moneda" value="COP" />
        <div className="sm:col-span-2"><FormField disabled={isSubmitting} hint="Puede ser cero. En esta versión se registran pesos enteros." id="account-initial-balance" label="Saldo inicial" onChange={(event) => setInitialBalance(event.target.value)} step="1" type="number" value={initialBalance} /></div>
      </div>
      {error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}
      <div className="mt-6 flex justify-end"><button className="rounded-2xl bg-[#173f31] px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={isSubmitting} type="submit">{isSubmitting ? 'Guardando…' : 'Guardar cuenta'}</button></div>
    </form>
  )
}
