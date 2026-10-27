import { useMemo, useState, type FormEvent } from 'react'
import { AuthNotice } from '../components/AuthNotice'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { FinanceHeader } from '../components/FinanceHeader'
import { FixedExpenseForm } from '../components/FixedExpenseForm'
import { FixedExpensePaymentForm } from '../components/FixedExpensePaymentForm'
import { FormDialog } from '../components/FormDialog'
import { FormField } from '../components/FormField'
import { formatCop, getBogotaToday, getCategoryLabel } from '../finance/calculations'
import { buildFixedExpensePeriodOverviews, calculateFixedExpenseSummary, getFixedExpensePeriodState } from '../finance/recurrence'
import { useFinance } from '../finance/useFinance'
import type { FixedExpense, FixedExpensePeriod, FixedExpenseVersion } from '../types/finance'

type View = 'upcoming' | 'pending' | 'overdue' | 'paid'
type Editor =
  | { type: 'expense'; expense?: FixedExpense; version?: FixedExpenseVersion }
  | { type: 'payment'; expense: FixedExpense; period: FixedExpensePeriod }
  | { type: 'reactivate'; expense: FixedExpense }
  | { type: 'detail'; expense: FixedExpense }
type Confirmation = { type: 'pause' | 'delete'; expense: FixedExpense } | { type: 'undo'; expense: FixedExpense; period: FixedExpensePeriod }

export function FixedExpensesPage() {
  const finance = useFinance()
  const today = getBogotaToday()
  const [view, setView] = useState<View>('pending')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [isConfirming, setIsConfirming] = useState(false)
  const [actionError, setActionError] = useState('')
  const expenseById = useMemo(() => new Map(finance.fixedExpenses.map((expense) => [expense.id, expense])), [finance.fixedExpenses])
  const latestVersionByExpense = useMemo(() => {
    const result = new Map<string, FixedExpenseVersion>()
    for (const version of finance.fixedExpenseVersions.filter((item) => !item.superseded_at)) {
      const current = result.get(version.fixed_expense_id)
      if (!current || current.effective_from < version.effective_from) result.set(version.fixed_expense_id, version)
    }
    return result
  }, [finance.fixedExpenseVersions])
  const periodSummary = useMemo(() => calculateFixedExpenseSummary(finance.fixedExpensePeriods, today), [finance.fixedExpensePeriods, today])
  const overviews = useMemo(() => buildFixedExpensePeriodOverviews(finance.fixedExpensePeriods, today), [finance.fixedExpensePeriods, today])
  const groupedRows = useMemo(() => {
    const rows = overviews.flatMap((overview) => {
      const period = view === 'upcoming' ? overview.nextMonthPending : view === 'overdue' ? overview.oldestOverdue : overview.mainPending
      if (!period) return []
      const additionalPendingCount = view === 'overdue'
        ? Math.max(overview.overdueCount - 1, 0)
        : view === 'pending'
          ? Math.max(overview.mainPendingCount - 1, 0)
          : 0
      return [{ additionalPendingCount, overview, period }]
    })
    return rows.sort((a, b) => a.period.due_date.localeCompare(b.period.due_date))
  }, [overviews, view])
  const paidRows = useMemo(() => [...periodSummary.paidThisMonth].sort((a, b) => (b.paid_on ?? '').localeCompare(a.paid_on ?? '')), [periodSummary.paidThisMonth])
  const activeExpenses = finance.fixedExpenses.filter((expense) => expense.status !== 'deleted')
  const deletedExpenses = finance.fixedExpenses.filter((expense) => expense.status === 'deleted')

  function closeEditor() {
    if (dirty && !window.confirm('Tienes cambios sin guardar. ¿Quieres descartarlos?')) return
    setDirty(false)
    setEditor(null)
  }

  async function confirmAction() {
    if (!confirmation) return
    setIsConfirming(true)
    setActionError('')
    try {
      if (confirmation.type === 'pause') await finance.pauseFixedExpense(confirmation.expense.id)
      if (confirmation.type === 'delete') await finance.removeFixedExpense(confirmation.expense.id)
      if (confirmation.type === 'undo') await finance.undoFixedExpensePayment(confirmation.period.id)
      await finance.refresh()
      setConfirmation(null)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'No pudimos completar la acción.')
      setConfirmation(null)
    } finally { setIsConfirming(false) }
  }

  return <div className="min-h-screen bg-[#f4f7f1]">
    <FinanceHeader realtimeStatus={finance.realtimeStatus} />
    <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 lg:px-12">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#4f8068]">Finanzas personales</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-[#173f31] sm:text-5xl">Gastos fijos</h1><p className="mt-3 max-w-2xl leading-7 text-[#66796f]">Planifica obligaciones recurrentes sin descontarlas del saldo hasta registrar el pago real.</p></div><button className="min-h-12 rounded-2xl bg-[#173f31] px-5 py-3 font-semibold text-white" onClick={() => { setDirty(false); setEditor({ type: 'expense' }) }} type="button">Nuevo gasto fijo</button></div>
      {(finance.error || actionError) && <div className="mt-6"><AuthNotice tone="error">{finance.error || actionError}</AuthNotice></div>}

      <section aria-label="Resumen de obligaciones" className="mt-9 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatusCard count={periodSummary.pendingThisMonth.length} detail={`${periodSummary.currentMonth.start} a ${periodSummary.currentMonth.end} · vencimientos impagos; los anteriores a hoy también cuentan como vencidos.`} label="Pendientes del mes" value={periodSummary.pendingThisMonthAmount} />
        <StatusCard count={periodSummary.overdue.length} detail="Todas las obligaciones impagas anteriores a hoy, incluso las de este mes." label="Vencidos" tone="danger" value={periodSummary.overdueAmount} />
        <StatusCard count={periodSummary.paidThisMonth.length} detail={`${periodSummary.currentMonth.start} a ${periodSummary.currentMonth.end} · usa la fecha real de pago, no el vencimiento.`} label="Pagados este mes" tone="positive" value={periodSummary.paidThisMonthAmount} />
        <StatusCard count={periodSummary.nextMonthPending.length} detail={`${periodSummary.nextMonth.start} a ${periodSummary.nextMonth.end} · obligaciones impagas del próximo mes; no son pendientes del mes actual.`} label="Próximo mes" value={periodSummary.nextMonthPendingAmount} />
      </section>

      <section className="mt-12"><div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"><div><h2 className="text-2xl font-semibold tracking-[-0.03em] text-[#173f31]">Obligaciones</h2><p className="mt-2 text-sm text-[#66796f]">La vista principal reúne deudas vencidas y pendientes con vencimiento en {periodSummary.currentMonth.start.slice(0, 7)}. Un vencimiento anterior a hoy dentro del mes pertenece a ambos totales.</p>{periodSummary.prepaidDueThisMonth.length > 0 && <p className="mt-2 text-sm font-semibold text-[#347151]">{periodSummary.prepaidDueThisMonth.length} obligación{periodSummary.prepaidDueThisMonth.length === 1 ? '' : 'es'} de este mes fue pagada anticipadamente y permanece como pagada en su detalle.</p>}</div><div aria-label="Filtrar obligaciones" className="grid grid-cols-2 gap-2 sm:flex">{([['pending', 'Pendientes del mes'], ['overdue', 'Vencidos'], ['paid', 'Pagados este mes'], ['upcoming', 'Próximo mes']] as const).map(([value, label]) => <button aria-pressed={view === value} className={`rounded-xl px-3 py-2 text-sm font-semibold ${view === value ? 'bg-[#173f31] text-white' : 'bg-white text-[#456356]'}`} key={value} onClick={() => setView(value)} type="button">{label}</button>)}</div></div>
        {finance.isLoading ? <Loading /> : (view === 'paid' ? paidRows.length === 0 : groupedRows.length === 0) ? <Empty title="No hay obligaciones en este estado" description={view === 'pending' ? 'No hay deudas vencidas ni obligaciones impagas con vencimiento este mes.' : view === 'paid' ? 'No hay pagos cuya fecha real pertenezca al mes actual.' : 'Los demás vencimientos futuros siguen disponibles en el detalle de cada gasto fijo.'} /> : <div className="mt-5 overflow-hidden rounded-[24px] border border-[#dce6d9] bg-white">{view === 'paid' ? paidRows.map((period) => { const expense = expenseById.get(period.fixed_expense_id); if (!expense) return null; return <PeriodRow additionalPendingCount={0} expense={expense} key={period.id} period={period} today={today} categories={finance.categories} accounts={finance.accounts} onDetail={() => { setDirty(false); setEditor({ type: 'detail', expense }) }} onPay={() => { setDirty(false); setEditor({ type: 'payment', expense, period }) }} onUndo={() => setConfirmation({ type: 'undo', expense, period })} /> }) : groupedRows.map(({ additionalPendingCount, overview, period }) => { const expense = expenseById.get(period.fixed_expense_id); if (!expense) return null; return <PeriodRow additionalPendingCount={additionalPendingCount} expense={expense} key={period.id} period={period} today={today} categories={finance.categories} accounts={finance.accounts} onDetail={() => { setDirty(false); setEditor({ type: 'detail', expense }) }} onPay={() => { setDirty(false); setEditor({ type: 'payment', expense, period }) }} onUndo={() => setConfirmation({ type: 'undo', expense, period })} overdueCount={overview.overdueCount} /> })}</div>}
      </section>

      <section className="mt-14 pb-16"><h2 className="text-2xl font-semibold tracking-[-0.03em] text-[#173f31]">Configuraciones recurrentes</h2><p className="mt-2 text-sm text-[#66796f]">Pausa o cambia solo lo que ocurrirá en adelante; el historial permanece intacto.</p>{activeExpenses.length === 0 ? <Empty title="Aún no tienes gastos fijos" description="Crea una suscripción u obligación mensual o anual." /> : <div className="mt-5 grid gap-4 md:grid-cols-2">{activeExpenses.map((expense) => <ExpenseCard expense={expense} key={expense.id} version={latestVersionByExpense.get(expense.id)} categories={finance.categories} accounts={finance.accounts} onDetail={() => { setDirty(false); setEditor({ type: 'detail', expense }) }} onEdit={() => { setDirty(false); setEditor({ type: 'expense', expense, version: latestVersionByExpense.get(expense.id) }) }} onPause={() => setConfirmation({ type: 'pause', expense })} onReactivate={() => { setDirty(false); setEditor({ type: 'reactivate', expense }) }} onDelete={() => setConfirmation({ type: 'delete', expense })} />)}</div>}{deletedExpenses.length > 0 && <details className="mt-5 rounded-2xl border border-[#dce6d9] bg-white p-5"><summary className="cursor-pointer font-semibold text-[#456356]">Dados de baja ({deletedExpenses.length})</summary><div className="mt-3 space-y-3">{deletedExpenses.map((expense) => <div className="flex flex-wrap items-center justify-between gap-3" key={expense.id}><p className="text-sm text-[#66796f]">{expense.name} · historial conservado</p><button className="text-sm font-semibold text-[#346a52]" onClick={() => { setDirty(false); setEditor({ type: 'detail', expense }) }} type="button">Ver detalle</button></div>)}</div></details>}</section>
    </main>

    {editor?.type === 'expense' && <FormDialog onClose={closeEditor} title={editor.expense ? 'Editar gasto fijo' : 'Nuevo gasto fijo'}><FixedExpenseForm expense={editor.expense} version={editor.version} onCancel={closeEditor} onDirtyChange={setDirty} onSaved={() => { setDirty(false); setEditor(null) }} /></FormDialog>}
    {editor?.type === 'payment' && <FormDialog onClose={closeEditor} title="Registrar pago"><FixedExpensePaymentForm expense={editor.expense} period={editor.period} onCancel={closeEditor} onDirtyChange={setDirty} onSaved={() => { setDirty(false); setEditor(null) }} /></FormDialog>}
    {editor?.type === 'reactivate' && <FormDialog onClose={closeEditor} title="Reactivar gasto fijo"><ReactivateForm expense={editor.expense} onCancel={closeEditor} onDirtyChange={setDirty} onSaved={() => { setDirty(false); setEditor(null) }} /></FormDialog>}
    {editor?.type === 'detail' && <FormDialog onClose={closeEditor} title={`Detalle de ${editor.expense.name}`}><FixedExpenseDetail accounts={finance.accounts} categories={finance.categories} expense={editor.expense} periods={finance.fixedExpensePeriods.filter((period) => period.fixed_expense_id === editor.expense.id)} today={today} onClose={closeEditor} onPay={(period) => { setDirty(false); setEditor({ type: 'payment', expense: editor.expense, period }) }} onUndo={(period) => setConfirmation({ type: 'undo', expense: editor.expense, period })} /></FormDialog>}
    {confirmation && <ConfirmDialog confirmLabel={confirmation.type === 'pause' ? 'Pausar' : confirmation.type === 'delete' ? 'Dar de baja' : 'Deshacer pago'} description={confirmation.type === 'pause' ? 'Se conservarán pagos y obligaciones ya vencidas. No se crearán nuevos períodos durante la pausa.' : confirmation.type === 'delete' ? 'Se cancelarán obligaciones pendientes con vencimiento desde hoy; las ya vencidas seguirán pendientes y todo el historial pagado se conservará.' : `Se eliminará lógicamente el gasto registrado para “${confirmation.expense.name}” y la obligación volverá a pendiente.`} isBusy={isConfirming} onCancel={() => setConfirmation(null)} onConfirm={() => void confirmAction()} title={confirmation.type === 'pause' ? '¿Pausar este gasto fijo?' : confirmation.type === 'delete' ? '¿Dar de baja este gasto fijo?' : '¿Deshacer este pago?'} />}
  </div>
}

function ReactivateForm({ expense, onCancel, onDirtyChange, onSaved }: { expense: FixedExpense; onCancel: () => void; onDirtyChange: (dirty: boolean) => void; onSaved: () => void }) {
  const finance = useFinance(); const today = getBogotaToday(); const [date, setDate] = useState(today); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) { event.preventDefault(); if (date < today) return setError('El próximo vencimiento no puede estar en el pasado.'); setBusy(true); try { await finance.reactivateFixedExpense(expense.id, date); await finance.refresh(); onSaved() } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos reactivar el gasto fijo.') } finally { setBusy(false) } }
  return <form className="bg-white p-6 sm:p-8" onChange={() => onDirtyChange(true)} onSubmit={submit}><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">Reactivar</p><h3 className="mt-2 text-2xl font-semibold text-[#173f31]">{expense.name}</h3></div><button className="text-sm font-semibold text-[#66796f]" onClick={onCancel} type="button">Cerrar</button></div><p className="mt-4 text-sm leading-6 text-[#66796f]">Elige el siguiente vencimiento. No se crearán cobros por el intervalo pausado.</p><div className="mt-5"><FormField data-dialog-initial-focus id="reactivate-date" label="Siguiente vencimiento" min={today} onChange={(event) => setDate(event.target.value)} type="date" value={date} /></div>{error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}<div className="mt-6 flex justify-end"><button className="rounded-2xl bg-[#173f31] px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={busy} type="submit">{busy ? 'Reactivando…' : 'Reactivar'}</button></div></form>
}

function StatusCard({ label, count, value, detail, tone = 'default' }: { label: string; count: number; value: bigint; detail: string; tone?: 'default' | 'danger' | 'positive' }) { const color = tone === 'danger' ? 'text-[#9a493e]' : tone === 'positive' ? 'text-[#2f7650]' : 'text-[#173f31]'; return <article className="min-w-0 rounded-[20px] border border-[#dce6d9] bg-white p-4 sm:p-5"><p className="text-sm text-[#66796f]">{label} · {count}</p><p className={`mt-2 break-words text-lg font-semibold sm:text-2xl ${color}`}>{formatCop(value)}</p><p className="mt-2 text-xs leading-5 text-[#829188]">{detail}</p></article> }
function Empty({ title, description }: { title: string; description: string }) { return <div className="mt-5 rounded-[24px] border border-dashed border-[#cddbc9] bg-white/55 px-6 py-10 text-center"><p className="font-semibold text-[#456356]">{title}</p><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#7a8b82]">{description}</p></div> }
function Loading() { return <div className="mt-5 rounded-[24px] bg-white p-8 text-center text-sm text-[#66796f]" role="status">Cargando gastos fijos…</div> }

function PeriodRow({ expense, period, today, categories, accounts, additionalPendingCount, overdueCount = 0, onDetail, onPay, onUndo }: { expense: FixedExpense; period: FixedExpensePeriod; today: string; categories: ReturnType<typeof useFinance>['categories']; accounts: ReturnType<typeof useFinance>['accounts']; additionalPendingCount: number; overdueCount?: number; onDetail?: () => void; onPay: () => void; onUndo: () => void }) {
  const state = getFixedExpensePeriodState(period, today); const account = accounts.find((item) => item.id === (period.paid_account_id ?? period.suggested_account_id)); const unavailable = !categories.some((item) => item.id === period.category_id && !item.archived_at) || (period.suggested_account_id ? !accounts.some((item) => item.id === period.suggested_account_id && !item.archived_at) : false)
  return <article className="flex flex-col gap-4 border-b border-[#e5ebe2] p-5 last:border-b-0 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${state === 'overdue' ? 'bg-[#f8e7e3] text-[#94443a]' : state === 'paid' ? 'bg-[#e4f1e5] text-[#2f7650]' : 'bg-[#edf3ea] text-[#4f8068]'}`}>{state === 'overdue' ? 'Vencido' : state === 'paid' ? 'Pagado' : 'Pendiente'}</span><span className="text-xs text-[#829188]">Vence {period.due_date}</span></div><h3 className="mt-2 font-semibold text-[#264a3c]">{expense.name}</h3><p className="mt-1 text-sm text-[#718279]">{getCategoryLabel(period.category_id, categories)}{account ? ` · ${account.name}${account.archived_at ? ' (archivada)' : ''}` : ''}</p>{additionalPendingCount > 0 && <p className="mt-1 text-sm font-semibold text-[#78622f]">{additionalPendingCount} pago{additionalPendingCount === 1 ? '' : 's'} adicional{additionalPendingCount === 1 ? '' : 'es'} pendiente{additionalPendingCount === 1 ? '' : 's'}{overdueCount > 1 ? ` · ${overdueCount} vencidos en total` : ''}</p>}{unavailable && !period.transaction_id && <p className="mt-1 text-xs font-semibold text-[#9a493e]">Selecciona una categoría o cuenta activa al pagar.</p>}</div><div className="sm:text-right"><p className="text-xl font-semibold text-[#173f31]">{formatCop(period.transaction_id ? period.paid_amount ?? 0 : period.expected_amount)}</p>{period.transaction_id && <p className="mt-1 text-xs text-[#718279]">Pagado el {period.paid_on}</p>}</div><div className="flex flex-wrap items-center gap-3 sm:flex-col sm:items-end">{period.transaction_id ? <button className="text-left text-sm font-semibold text-[#8b554d] sm:text-right" onClick={onUndo} type="button">Deshacer pago</button> : <button className="rounded-xl bg-[#173f31] px-4 py-2.5 text-sm font-semibold text-white" onClick={onPay} type="button">Marcar como pagado</button>}{onDetail && <button className="text-sm font-semibold text-[#346a52]" onClick={onDetail} type="button">Ver detalle</button>}</div></article>
}

function FixedExpenseDetail({ expense, periods, today, categories, accounts, onClose, onPay, onUndo }: { expense: FixedExpense; periods: FixedExpensePeriod[]; today: string; categories: ReturnType<typeof useFinance>['categories']; accounts: ReturnType<typeof useFinance>['accounts']; onClose: () => void; onPay: (period: FixedExpensePeriod) => void; onUndo: (period: FixedExpensePeriod) => void }) {
  const pending = periods.filter((period) => !period.cancelled_at && !period.transaction_id).sort((a, b) => a.due_date.localeCompare(b.due_date))
  const overdue = pending.filter((period) => period.due_date < today)
  const upcoming = pending.filter((period) => period.due_date >= today)
  const paid = periods.filter((period) => period.transaction_id).sort((a, b) => (b.paid_on ?? '').localeCompare(a.paid_on ?? ''))
  const cancelled = periods.filter((period) => period.cancelled_at).sort((a, b) => a.due_date.localeCompare(b.due_date))
  const status = expense.status === 'active' ? 'Activo' : expense.status === 'paused' ? 'Pausado' : 'Dado de baja'

  return <div className="bg-white p-6 sm:p-8">
    <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">Detalle del gasto fijo</p><h3 className="mt-2 text-2xl font-semibold text-[#173f31]">{expense.name}</h3><p className="mt-2 text-sm text-[#66796f]">{status} · {pending.length} pago{pending.length === 1 ? '' : 's'} pendiente{pending.length === 1 ? '' : 's'} · {paid.length} pagado{paid.length === 1 ? '' : 's'}</p></div><button className="text-sm font-semibold text-[#66796f]" data-dialog-initial-focus onClick={onClose} type="button">Cerrar</button></div>
    <DetailSection empty="No hay pagos vencidos." title={`Vencidos (${overdue.length})`}>{overdue.map((period) => <PeriodRow accounts={accounts} additionalPendingCount={0} categories={categories} expense={expense} key={period.id} onPay={() => onPay(period)} onUndo={() => onUndo(period)} period={period} today={today} />)}</DetailSection>
    <DetailSection empty="No hay vencimientos futuros generados." title={`Próximos vencimientos (${upcoming.length})`}>{upcoming.map((period) => <PeriodRow accounts={accounts} additionalPendingCount={0} categories={categories} expense={expense} key={period.id} onPay={() => onPay(period)} onUndo={() => onUndo(period)} period={period} today={today} />)}</DetailSection>
    <DetailSection empty="Todavía no hay pagos registrados." title={`Historial de pagos (${paid.length})`}>{paid.map((period) => <PeriodRow accounts={accounts} additionalPendingCount={0} categories={categories} expense={expense} key={period.id} onPay={() => onPay(period)} onUndo={() => onUndo(period)} period={period} today={today} />)}</DetailSection>
    {cancelled.length > 0 && <details className="mt-6 rounded-2xl bg-[#f4f7f1] p-4"><summary className="cursor-pointer text-sm font-semibold text-[#52675d]">Períodos cancelados ({cancelled.length})</summary><div className="mt-3 space-y-2">{cancelled.map((period) => <p className="text-sm text-[#718279]" key={period.id}>{period.due_date} · {formatCop(period.expected_amount)} · {period.cancellation_reason === 'paused' ? 'pausa' : period.cancellation_reason === 'deleted' ? 'baja' : 'configuración sustituida'}</p>)}</div></details>}
  </div>
}

function DetailSection({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children)
  return <section className="mt-7"><h4 className="text-lg font-semibold text-[#264a3c]">{title}</h4>{hasChildren ? <div className="mt-3 overflow-hidden rounded-2xl border border-[#e1e8de]">{children}</div> : <p className="mt-3 rounded-2xl bg-[#f4f7f1] p-4 text-sm text-[#718279]">{empty}</p>}</section>
}

function ExpenseCard({ expense, version, categories, accounts, onDetail, onEdit, onPause, onReactivate, onDelete }: { expense: FixedExpense; version?: FixedExpenseVersion; categories: ReturnType<typeof useFinance>['categories']; accounts: ReturnType<typeof useFinance>['accounts']; onDetail: () => void; onEdit: () => void; onPause: () => void; onReactivate: () => void; onDelete: () => void }) {
  const account = accounts.find((item) => item.id === version?.suggested_account_id)
  return <article className="rounded-[24px] border border-[#dce6d9] bg-white p-5"><div className="flex items-start justify-between gap-3"><div><h3 className="text-xl font-semibold text-[#173f31]">{expense.name}</h3>{version && <p className="mt-2 text-sm text-[#66796f]">{formatCop(version.expected_amount)} · {version.frequency === 'monthly' ? 'Mensual' : 'Anual'}</p>}</div><span className={`rounded-full px-3 py-1 text-xs font-semibold ${expense.status === 'active' ? 'bg-[#e5f2e4] text-[#347151]' : 'bg-[#f1eee4] text-[#796b3e]'}`}>{expense.status === 'active' ? 'Activo' : 'Pausado'}</span></div>{version && <p className="mt-3 text-sm leading-6 text-[#718279]">{getCategoryLabel(version.category_id, categories)} · {account ? `${account.name}${account.archived_at ? ' (archivada)' : ''}` : 'Cuenta al pagar'} · calendario desde {version.anchor_date}</p>}{expense.notes && <p className="mt-3 text-sm text-[#718279]">{expense.notes}</p>}<div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm font-semibold"><button className="text-[#346a52]" onClick={onDetail} type="button">Ver detalle</button><button className="text-[#346a52]" onClick={onEdit} type="button">Editar</button>{expense.status === 'active' ? <button className="text-[#78622f]" onClick={onPause} type="button">Pausar</button> : <button className="text-[#346a52]" onClick={onReactivate} type="button">Reactivar</button>}<button className="text-[#8b554d]" onClick={onDelete} type="button">Dar de baja</button></div></article>
}
