import { useRef, useState, type FormEvent } from 'react'
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
  const balanceInputRef = useRef<HTMLInputElement>(null)

  const isNegativeBalance = initialBalance.trim().startsWith('-')

  function markDirty() {
    onDirtyChange(true)
  }

  function toggleInitialBalanceSign() {
    markDirty()
    setInitialBalance((prev) => {
      const trimmed = prev.trim()
      if (!trimmed || trimmed === '0') return '-'
      if (trimmed === '-') return '0'
      return trimmed.startsWith('-') ? trimmed.slice(1) : `-${trimmed}`
    })
    balanceInputRef.current?.focus()
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    const rawBalance = initialBalance.trim()
    if (!name.trim()) return setError('Escribe un nombre para la cuenta.')
    if (!rawBalance || !/^-?\d+$/.test(rawBalance)) {
      return setError('El saldo inicial debe ser un número entero válido en pesos.')
    }
    const parsed = Number(rawBalance)
    const amount = Object.is(parsed, -0) ? 0 : parsed
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
        <div className="sm:col-span-2">
          <label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="account-initial-balance">
            Saldo inicial
          </label>
          <div className="flex items-stretch gap-2">
            <button
              aria-label="Cambiar signo del saldo inicial"
              aria-pressed={isNegativeBalance}
              className={`min-h-12 shrink-0 rounded-2xl border px-3.5 text-sm font-semibold transition ${
                isNegativeBalance
                  ? 'border-[#e8d1cc] bg-[#f8ece8] text-[#8b463d]'
                  : 'border-[#d6e1d3] bg-[#f8faf6] text-[#315c49] hover:bg-[#edf3ea]'
              } disabled:cursor-not-allowed disabled:opacity-60`}
              disabled={isSubmitting}
              onClick={toggleInitialBalanceSign}
              type="button"
            >
              ± Signo
            </button>
            <input
              autoComplete="off"
              className="min-w-0 flex-1 rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5 text-base text-[#173f31] outline-none transition placeholder:text-[#9aa9a1] focus:border-[#4f8068] focus:ring-4 focus:ring-[#4f8068]/10 disabled:cursor-not-allowed disabled:bg-[#f0f3ed]"
              disabled={isSubmitting}
              id="account-initial-balance"
              inputMode="numeric"
              onChange={(event) => setInitialBalance(event.target.value)}
              ref={balanceInputRef}
              type="text"
              value={initialBalance}
            />
          </div>
          <p className="mt-2 text-xs leading-5 text-[#718279]">
            Puede ser cero, positivo o negativo (usa «± Signo» en el celular). Se registran pesos enteros.
          </p>
        </div>
      </div>
      {error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}
      <div className="mt-6 flex justify-end"><button className="rounded-2xl bg-[#173f31] px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={isSubmitting} type="submit">{isSubmitting ? 'Guardando…' : 'Guardar cuenta'}</button></div>
    </form>
  )
}
