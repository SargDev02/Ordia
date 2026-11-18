import { useState } from 'react'
import { formatCop, normalizeCategorySearch } from '../finance/calculations'
import type { BankNotification, FixedExpense, FixedExpensePaymentInput, FixedExpensePeriod } from '../types/finance'
import { FixedExpensePaymentForm } from './FixedExpensePaymentForm'

export function BankFixedExpensePayment({ notice, expenses, periods, accountId, onPay, onCancel, onSaved }: {
  notice: BankNotification; expenses: FixedExpense[]; periods: FixedExpensePeriod[]; accountId: string
  onPay: (notificationId: string, periodId: string, requestId: string, input: FixedExpensePaymentInput) => Promise<void>
  onCancel: () => void; onSaved: () => void
}) {
  const [search, setSearch] = useState('')
  const [periodId, setPeriodId] = useState('')
  const eligible = periods.filter((period) => period.user_id === notice.user_id && !period.cancelled_at && !period.transaction_id)
    .flatMap((period) => {
      const expense = expenses.find((item) => item.id === period.fixed_expense_id && item.user_id === notice.user_id)
      return expense ? [{ period, expense }] : []
    }).sort((a, b) => a.period.due_date.localeCompare(b.period.due_date))
  const selected = eligible.find(({ period }) => period.id === periodId)
  const matches = eligible.filter(({ period, expense }) => normalizeCategorySearch(`${expense.name} ${period.due_date}`).includes(normalizeCategorySearch(search)))
  return <div className="mt-4">
    <label className="block text-sm font-semibold" htmlFor="fixed-payment-search">Buscar gasto fijo u obligación</label>
    <input className="mt-2 w-full rounded-xl border border-[#d6e1d3] p-3" id="fixed-payment-search" value={search} onChange={(event) => setSearch(event.target.value)} />
    <label className="mt-3 block text-sm font-semibold" htmlFor="fixed-payment-period">Obligación que se pagó</label>
    <select className="mt-2 w-full rounded-xl border border-[#d6e1d3] p-3" id="fixed-payment-period" value={periodId} onChange={(event) => setPeriodId(event.target.value)}>
      <option value="">Selecciona gasto fijo y período</option>
      {matches.map(({ period, expense }) => <option key={period.id} value={period.id}>{expense.name} · período {period.due_date.slice(0, 7)} · vence {period.due_date} · previsto {formatCop(period.expected_amount)}</option>)}
    </select>
    {!matches.length && <p className="mt-3 text-sm">No hay obligaciones pendientes compatibles con la búsqueda. Las pagadas se vinculan mediante «Ya lo registré».</p>}
    {periodId && !selected && <p role="status" className="mt-3 text-sm">Esta obligación ya no está pendiente. Si ya está pagada, usa «Ya lo registré» para vincular su movimiento.</p>}
    {selected && <FixedExpensePaymentForm key={selected.period.id} expense={selected.expense} period={selected.period}
      initialPayment={{ account_id: accountId, category_id: selected.period.category_id, amount: notice.amount, paid_on: notice.occurred_on }}
      onCancel={onCancel} onDirtyChange={() => {}} onSaved={onSaved}
      onPay={(id, request, input) => onPay(notice.id, id, request, input)} />}
  </div>
}
