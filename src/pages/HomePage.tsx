import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useFinance } from '../finance/useFinance'
import { calculateAccountBalance, calculatePeriodSummary, filterTransactions, formatCop, getBogotaToday, getCategoryLabel } from '../finance/calculations'
import { calculateFixedExpenseSummary } from '../finance/recurrence'
import { ACCOUNT_TYPE_LABELS, TRANSACTION_KIND_LABELS } from '../finance/constants'
import type { FinancialAccount, FinancialCategory, FinancialTransaction, TransactionKind } from '../types/finance'
import { AccountForm } from '../components/AccountForm'
import { AuthNotice } from '../components/AuthNotice'
import { FinanceHeader } from '../components/FinanceHeader'
import { CategoryManager } from '../components/CategoryManager'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { FormDialog } from '../components/FormDialog'
import { TransactionForm } from '../components/TransactionForm'
import { HomeTasks } from '../components/HomeTasks'
import { HomeCalendar } from '../components/HomeCalendar'

type Confirmation = { type: 'archive'; account: FinancialAccount } | { type: 'delete'; transaction: FinancialTransaction }
type Editor =
  | { type: 'account'; account?: FinancialAccount }
  | { type: 'transaction'; initialKind: TransactionKind; transaction?: FinancialTransaction }

export function HomePage() {
  const finance = useFinance()
  const [editor, setEditor] = useState<Editor | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)
  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false)
  const [categoryManagerDirty, setCategoryManagerDirty] = useState(false)
  const [unavailableKind, setUnavailableKind] = useState<TransactionKind | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [isConfirming, setIsConfirming] = useState(false)
  const [actionError, setActionError] = useState('')
  const [accountSelection, setAccountSelection] = useState<string[] | null>(null)
  const [kindFilter, setKindFilter] = useState<TransactionKind | ''>('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')

  const activeAccounts = finance.accounts.filter((account) => !account.archived_at)
  const archivedAccounts = finance.accounts.filter((account) => account.archived_at)
  const selectedAccountIds = useMemo(() => accountSelection === null
    ? new Set(finance.accounts.map((account) => account.id))
    : new Set(accountSelection.filter((id) => finance.accounts.some((account) => account.id === id))),
  [accountSelection, finance.accounts])
  const filters = useMemo(() => ({ accountIds: selectedAccountIds, dateFrom, dateTo, kind: kindFilter }), [dateFrom, dateTo, kindFilter, selectedAccountIds])
  const summary = useMemo(() => calculatePeriodSummary(finance.transactions, finance.categories, filters), [finance.categories, finance.transactions, filters])
  const filteredTransactions = useMemo(() => filterTransactions(finance.transactions, filters), [finance.transactions, filters])
  const totalBalance = useMemo(() => finance.accounts.filter((account) => selectedAccountIds.has(account.id)).reduce(
    (total, account) => total + calculateAccountBalance(account, finance.transactions), 0n,
  ), [finance.accounts, finance.transactions, selectedAccountIds])
  const accountNames = useMemo(() => new Map(finance.accounts.map((account) => [account.id, account.name])), [finance.accounts])
  const categoryNames = useMemo(() => new Map(finance.categories.map((category) => [category.id, category.name])), [finance.categories])
  const fixedPaymentTransactions = useMemo(() => new Set(finance.fixedExpensePeriods.flatMap((period) => period.transaction_id ? [period.transaction_id] : [])), [finance.fixedExpensePeriods])
  const today = getBogotaToday()
  const fixedExpenseSummary = useMemo(() => calculateFixedExpenseSummary(finance.fixedExpensePeriods, today), [finance.fixedExpensePeriods, today])
  const selectionDetail = accountSelection === null
    ? `Todas las cuentas (${finance.accounts.length})`
    : accountSelection.length === 0
      ? 'Ninguna cuenta seleccionada'
      : `${selectedAccountIds.size} cuenta${selectedAccountIds.size === 1 ? '' : 's'} seleccionada${selectedAccountIds.size === 1 ? '' : 's'}`

  function openAccount(account?: FinancialAccount) {
    setUnavailableKind(null)
    setEditorDirty(false)
    setEditor({ type: 'account', account })
  }

  function openTransaction(initialKind: TransactionKind, transaction?: FinancialTransaction) {
    const requiredAccounts = initialKind === 'transfer' ? 2 : 1
    if (!transaction && activeAccounts.length < requiredAccounts) {
      setUnavailableKind(initialKind)
      return
    }
    setEditorDirty(false)
    setEditor({ type: 'transaction', initialKind, transaction })
  }

  function closeEditor() {
    if (editorDirty && !window.confirm('Tienes cambios sin guardar. ¿Quieres descartarlos?')) return
    setEditorDirty(false)
    setEditor(null)
  }

  function closeCategoryManager() {
    if (categoryManagerDirty && !window.confirm('Tienes cambios sin guardar. ¿Quieres descartarlos?')) return
    setCategoryManagerDirty(false)
    setCategoryManagerOpen(false)
  }

  function toggleAccount(accountId: string) {
    const current = accountSelection === null ? finance.accounts.map((account) => account.id) : accountSelection
    setAccountSelection(current.includes(accountId) ? current.filter((id) => id !== accountId) : [...current, accountId])
  }

  async function handleConfirmation() {
    if (!confirmation) return
    setIsConfirming(true)
    setActionError('')
    try {
      if (confirmation.type === 'archive') await finance.archiveAccount(confirmation.account.id)
      else await finance.deleteTransaction(confirmation.transaction.id)
      setConfirmation(null)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : 'No pudimos completar la acción.')
      setConfirmation(null)
    } finally { setIsConfirming(false) }
  }

  return (
    <div className="min-h-screen bg-[#f4f7f1]">
      <FinanceHeader realtimeStatus={finance.realtimeStatus} />
      <main className="mx-auto max-w-7xl px-5 py-10 sm:px-8 lg:px-12">
        <div><p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#4f8068]">Finanzas personales</p><h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] text-[#173f31] sm:text-5xl">Tu dinero, con claridad.</h1></div>
        {(finance.error || actionError) && <div className="mt-6"><AuthNotice tone="error">{finance.error || actionError}</AuthNotice><button className="mt-3 text-sm font-semibold text-[#346a52] underline" onClick={() => void finance.refresh()} type="button">Volver a intentar</button></div>}

        <section className="mt-10 grid gap-4 sm:grid-cols-3" aria-label="Resumen financiero filtrado"><SummaryCard label="Saldo total" value={formatCop(totalBalance)} detail={selectionDetail} /><SummaryCard label="Ingresos del período" value={formatCop(summary.income)} detail={`${summary.start} a ${summary.end} · sin saldos iniciales ni transferencias`} tone="positive" /><SummaryCard label="Gastos del período" value={formatCop(summary.expense)} detail={`${summary.start} a ${summary.end} · sin transferencias`} tone="negative" /></section>
        <section className="mt-5" aria-label="Acciones financieras"><div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><QuickAction label="Registrar ingreso" tone="positive" onClick={() => openTransaction('income')} /><QuickAction label="Registrar gasto" tone="negative" onClick={() => openTransaction('expense')} /><QuickAction label="Transferir" tone="neutral" onClick={() => openTransaction('transfer')} /><QuickAction label="Nueva cuenta" tone="primary" onClick={() => openAccount()} /></div><button className="mt-4 text-sm font-semibold text-[#346a52] underline underline-offset-4" onClick={() => { setCategoryManagerDirty(false); setCategoryManagerOpen(true) }} type="button">Administrar categorías</button>{activeAccounts.length < 2 && <p className="mt-3 rounded-2xl bg-[#eaf0e7] px-4 py-3 text-sm leading-6 text-[#5f7469]">{activeAccounts.length === 0 ? 'Crea una cuenta activa para registrar ingresos o gastos. Para transferir necesitarás dos.' : 'Para transferir necesitas una segunda cuenta activa.'}{' '}<button className="font-semibold text-[#2f664d] underline underline-offset-2" onClick={() => openAccount()} type="button">Crear una cuenta</button></p>}</section>

        <HomeTasks />
        <HomeCalendar />
        <section className="mt-8 rounded-[24px] border border-[#dce6d9] bg-white p-5 sm:p-6" aria-label="Obligaciones del mes"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-sm font-semibold text-[#4f8068]">Obligaciones del mes</p><p className="mt-2 text-sm text-[#718279]">{fixedExpenseSummary.currentMonth.start} a {fixedExpenseSummary.currentMonth.end} · America/Bogota. No afectan saldos hasta pagarse.</p></div><Link className="inline-flex rounded-xl bg-[#edf3ea] px-4 py-2.5 text-sm font-semibold text-[#315c49]" to="/gastos-fijos">Ver gastos fijos</Link></div><div className="mt-5 grid gap-3 sm:grid-cols-2"><div className="rounded-2xl bg-[#f4f7f1] p-4"><p className="text-sm text-[#66796f]">Pendientes del mes · {fixedExpenseSummary.pendingThisMonth.length}</p><p className="mt-2 text-2xl font-semibold text-[#173f31]">{formatCop(fixedExpenseSummary.pendingThisMonthAmount)}</p></div><div className="rounded-2xl bg-[#f8ece8] p-4"><p className="text-sm text-[#8b554d]">Vencidos · {fixedExpenseSummary.overdue.length}</p><p className="mt-2 text-2xl font-semibold text-[#9a493e]">{formatCop(fixedExpenseSummary.overdueAmount)}</p></div></div><p className="mt-3 text-xs leading-5 text-[#829188]">Un vencimiento anterior a hoy dentro del mes aparece en ambos totales. Los meses futuros se consultan en el detalle.</p></section>

        <section className="mt-12"><SectionHeader title="Cuentas" description="Saldos actuales calculados desde el saldo inicial y todos los movimientos." />{finance.isLoading ? <LoadingBlock /> : activeAccounts.length === 0 ? <EmptyState title="Aún no tienes cuentas" description="Crea tu primera cuenta para empezar a registrar movimientos reales." /> : <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{activeAccounts.map((account) => <AccountCard key={account.id} account={account} balance={calculateAccountBalance(account, finance.transactions)} onEdit={() => openAccount(account)} onArchive={() => setConfirmation({ type: 'archive', account })} />)}</div>}{archivedAccounts.length > 0 && <details className="mt-5 rounded-2xl border border-[#dce6d9] bg-white p-5"><summary className="cursor-pointer font-semibold text-[#456356]">Cuentas archivadas ({archivedAccounts.length})</summary><div className="mt-4 grid gap-3 sm:grid-cols-2">{archivedAccounts.map((account) => <div className="rounded-xl bg-[#f4f7f1] p-4" key={account.id}><p className="font-semibold text-[#52675d]">{account.name}</p><p className="mt-1 text-sm text-[#718279]">Saldo conservado: {formatCop(calculateAccountBalance(account, finance.transactions))}</p><button className="mt-3 text-sm font-semibold text-[#346a52]" onClick={() => openAccount(account)} type="button">Editar datos</button></div>)}</div></details>}</section>

        <section className="mt-14"><SectionHeader title="Movimientos" description="Los filtros se aplican también al resumen. Una transferencia aparece una sola vez si seleccionas su origen o destino." /><div className="mt-5 rounded-2xl border border-[#dce6d9] bg-white p-4" aria-label="Filtros de movimientos"><AccountMultiSelect accounts={finance.accounts} allSelected={accountSelection === null} selected={selectedAccountIds} onAll={() => setAccountSelection(null)} onClear={() => setAccountSelection([])} onToggle={toggleAccount} /><div className="mt-4 grid gap-3 sm:grid-cols-3"><FilterSelect label="Tipo" value={kindFilter} onChange={(value) => setKindFilter(value as TransactionKind | '')} options={Object.entries(TRANSACTION_KIND_LABELS)} /><FilterDate label="Desde" value={dateFrom} onChange={setDateFrom} /><FilterDate label="Hasta" value={dateTo} onChange={setDateTo} /></div><p className="mt-3 text-xs text-[#718279]" aria-live="polite">{selectionDetail}</p></div>{filteredTransactions.length === 0 ? <EmptyState title={selectedAccountIds.size === 0 ? 'No hay cuentas seleccionadas' : 'No hay movimientos para mostrar'} description={selectedAccountIds.size === 0 ? 'Selecciona una o varias cuentas, o usa “Todas”.' : 'Registra un movimiento o ajusta los filtros.'} /> : <div className="mt-5 overflow-hidden rounded-[24px] border border-[#dce6d9] bg-white">{filteredTransactions.map((transaction) => <TransactionRow fixedPayment={fixedPaymentTransactions.has(transaction.id)} key={transaction.id} transaction={transaction} accountNames={accountNames} categories={finance.categories} onEdit={() => openTransaction(transaction.kind, transaction)} onDelete={() => setConfirmation({ type: 'delete', transaction })} />)}</div>}</section>

        <section className="mt-14 pb-16"><div className="mb-5"><h2 className="text-2xl font-semibold tracking-[-0.03em] text-[#173f31]">Gastos del período por categoría</h2><p className="mt-2 text-sm text-[#66796f]">Subcategorías sumadas una sola vez bajo su categoría principal · America/Bogota.</p></div>{summary.expensesByCategory.size === 0 ? <EmptyState title="Sin gastos en este alcance" description="Los gastos del período y cuentas seleccionadas aparecerán agrupados aquí." /> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[...summary.expensesByCategory.entries()].sort((a, b) => Number(b[1] - a[1])).map(([categoryId, amount]) => <div className="rounded-2xl border border-[#dce6d9] bg-white p-5" key={categoryId}><p className="text-sm text-[#66796f]">{categoryNames.get(categoryId) ?? 'Categoría no disponible'}</p><p className="mt-2 text-xl font-semibold text-[#173f31]">{formatCop(amount)}</p></div>)}</div>}</section>
      </main>

      {editor && <FormDialog onClose={closeEditor} title={editor.type === 'account' ? editor.account ? 'Editar cuenta' : 'Nueva cuenta' : editor.transaction ? 'Editar movimiento' : editor.initialKind === 'income' ? 'Registrar ingreso' : editor.initialKind === 'expense' ? 'Registrar gasto' : 'Transferir'}>{editor.type === 'account' ? <AccountForm account={editor.account} onCancel={closeEditor} onDirtyChange={setEditorDirty} onSaved={() => { setEditorDirty(false); setEditor(null) }} /> : <TransactionForm initialKind={editor.initialKind} transaction={editor.transaction} onCancel={closeEditor} onDirtyChange={setEditorDirty} onSaved={() => { setEditorDirty(false); setEditor(null) }} />}</FormDialog>}
      {categoryManagerOpen && <FormDialog onClose={closeCategoryManager} title="Administrar categorías"><CategoryManager onClose={closeCategoryManager} onDirtyChange={setCategoryManagerDirty} /></FormDialog>}
      {unavailableKind && <FormDialog onClose={() => setUnavailableKind(null)} title="Operación no disponible"><div className="p-6 sm:p-8"><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">Antes de continuar</p><h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#173f31]">{unavailableKind === 'transfer' ? 'Necesitas dos cuentas activas' : 'Necesitas una cuenta activa'}</h2><p className="mt-3 leading-7 text-[#66796f]">{unavailableKind === 'transfer' ? 'Crea otra cuenta para poder elegir un origen y un destino diferentes.' : `Crea una cuenta antes de registrar ${unavailableKind === 'income' ? 'un ingreso' : 'un gasto'}.`}</p><div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><button className="rounded-xl border border-[#d5e0d3] px-4 py-3 font-semibold text-[#456356]" onClick={() => setUnavailableKind(null)} type="button">Ahora no</button><button className="rounded-xl bg-[#173f31] px-4 py-3 font-semibold text-white" data-dialog-initial-focus onClick={() => openAccount()} type="button">Crear una cuenta</button></div></div></FormDialog>}
      {confirmation && <ConfirmDialog confirmLabel={confirmation.type === 'archive' ? 'Archivar cuenta' : 'Eliminar movimiento'} description={confirmation.type === 'archive' ? `La cuenta “${confirmation.account.name}” conservará su historial, pero no aceptará movimientos nuevos.` : 'El movimiento dejará de afectar saldos y reportes. Si es una transferencia, se eliminará completa.'} isBusy={isConfirming} onCancel={() => setConfirmation(null)} onConfirm={() => void handleConfirmation()} title={confirmation.type === 'archive' ? '¿Archivar esta cuenta?' : '¿Eliminar este movimiento?'} />}
    </div>
  )
}

function AccountMultiSelect({ accounts, allSelected, selected, onAll, onClear, onToggle }: { accounts: FinancialAccount[]; allSelected: boolean; selected: Set<string>; onAll: () => void; onClear: () => void; onToggle: (id: string) => void }) { return <fieldset className="min-w-0"><legend className="text-xs font-semibold text-[#66796f]">Cuentas</legend><div className="mt-2 flex min-w-0 flex-wrap gap-2"><button className={`rounded-full px-3 py-2 text-sm font-semibold ${allSelected ? 'bg-[#173f31] text-white' : 'bg-[#edf3ea] text-[#315c49]'}`} onClick={onAll} type="button">Todas</button><button className={`rounded-full px-3 py-2 text-sm font-semibold ${!allSelected && selected.size === 0 ? 'bg-[#173f31] text-white' : 'bg-[#edf3ea] text-[#315c49]'}`} onClick={onClear} type="button">Limpiar</button>{accounts.map((account) => <label className="flex max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-full border border-[#d6e1d3] px-3 py-2 text-sm" key={account.id}><input className="shrink-0" checked={selected.has(account.id)} onChange={() => onToggle(account.id)} type="checkbox" /><span className="min-w-0 break-words">{account.name}{account.archived_at ? ' · archivada' : ''}</span></label>)}</div></fieldset> }
function SummaryCard({ label, value, detail, tone = 'default' }: { label: string; value: string; detail: string; tone?: 'default' | 'positive' | 'negative' }) { const valueColor = tone === 'positive' ? 'text-[#2f7650]' : tone === 'negative' ? 'text-[#9a493e]' : 'text-[#173f31]'; return <article className="rounded-[24px] border border-[#dce6d9] bg-white p-6"><p className="text-sm text-[#66796f]">{label}</p><p className={`mt-3 text-3xl font-semibold tracking-[-0.04em] ${valueColor}`}>{value}</p><p className="mt-3 text-xs leading-5 text-[#829188]">{detail}</p></article> }
function SectionHeader({ title, description }: { title: string; description: string }) { return <div><h2 className="text-2xl font-semibold tracking-[-0.03em] text-[#173f31] sm:text-3xl">{title}</h2><p className="mt-2 text-sm leading-6 text-[#66796f]">{description}</p></div> }
function QuickAction({ label, onClick, tone }: { label: string; onClick: () => void; tone: 'positive' | 'negative' | 'neutral' | 'primary' }) { const colors = tone === 'positive' ? 'border-[#c9ddcf] bg-[#e8f3e8] text-[#286646] hover:bg-[#dceedd]' : tone === 'negative' ? 'border-[#e8d1cc] bg-[#f8ece8] text-[#8b463d] hover:bg-[#f3ded8]' : tone === 'neutral' ? 'border-[#cfdee3] bg-[#eaf1f4] text-[#3e6572] hover:bg-[#dce9ed]' : 'border-[#173f31] bg-[#173f31] text-white hover:bg-[#24533f]'; return <button className={`min-h-14 min-w-0 rounded-2xl border px-3 py-3 text-sm font-semibold transition sm:px-5 sm:text-base ${colors}`} onClick={onClick} type="button">{label}</button> }
function AccountCard({ account, balance, onEdit, onArchive }: { account: FinancialAccount; balance: bigint; onEdit: () => void; onArchive: () => void }) { return <article className="rounded-[24px] border border-[#dce6d9] bg-white p-6"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#789086]">{ACCOUNT_TYPE_LABELS[account.account_type]} · COP</p><h3 className="mt-2 text-xl font-semibold text-[#173f31]">{account.name}</h3></div><span className="rounded-full bg-[#edf5e8] px-3 py-1 text-xs font-semibold text-[#4f8068]">Activa</span></div><p className="mt-7 text-3xl font-semibold tracking-[-0.04em] text-[#173f31]">{formatCop(balance)}</p><p className="mt-2 text-xs text-[#829188]">Inicial: {formatCop(account.initial_balance)}</p><div className="mt-6 flex gap-4 text-sm font-semibold"><button className="text-[#346a52]" onClick={onEdit} type="button">Editar</button><button className="text-[#8b554d]" onClick={onArchive} type="button">Archivar</button></div></article> }
function TransactionRow({ transaction, accountNames, categories, fixedPayment, onEdit, onDelete }: { transaction: FinancialTransaction; accountNames: Map<string, string>; categories: FinancialCategory[]; fixedPayment: boolean; onEdit: () => void; onDelete: () => void }) { const sign = transaction.kind === 'income' ? '+' : transaction.kind === 'expense' ? '−' : '↔'; const color = transaction.kind === 'income' ? 'text-[#2f7650]' : transaction.kind === 'expense' ? 'text-[#9a493e]' : 'text-[#4f6d80]'; const accountLabel = transaction.kind === 'transfer' ? `${accountNames.get(transaction.account_id) ?? 'Cuenta'} → ${accountNames.get(transaction.destination_account_id ?? '') ?? 'Cuenta'}` : accountNames.get(transaction.account_id) ?? 'Cuenta'; const categoryLabel = getCategoryLabel(transaction.category_id, categories); return <article className="flex flex-col gap-4 border-b border-[#e5ebe2] p-5 last:border-b-0 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#718279]">{TRANSACTION_KIND_LABELS[transaction.kind]}</span>{fixedPayment && <span className="rounded-full bg-[#edf3ea] px-2 py-0.5 text-[11px] font-semibold text-[#4f8068]">Gasto fijo</span>}<span className="text-xs text-[#9aa79f]">{transaction.occurred_on}</span></div><p className="mt-1 truncate font-semibold text-[#264a3c]">{transaction.description || categoryLabel}</p>{transaction.kind !== 'transfer' && transaction.description && <p className="mt-1 text-sm text-[#718279]">{categoryLabel}</p>}<p className="mt-1 text-sm text-[#718279]">{accountLabel}</p></div><p className={`text-xl font-semibold ${color}`}>{sign} {formatCop(transaction.amount)}</p>{fixedPayment ? <Link className="text-sm font-semibold text-[#346a52]" to="/gastos-fijos">Gestionar pago</Link> : <div className="flex gap-4 text-sm font-semibold"><button className="text-[#346a52]" onClick={onEdit} type="button">Editar</button><button className="text-[#8b554d]" onClick={onDelete} type="button">Eliminar</button></div>}</article> }
function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) { const id = `filter-${label.toLowerCase()}`; return <div><label className="mb-1.5 block text-xs font-semibold text-[#66796f]" htmlFor={id}>{label}</label><select className="w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-2.5 text-sm" id={id} onChange={(event) => onChange(event.target.value)} value={value}><option value="">Todos</option>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select></div> }
function FilterDate({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { const id = `filter-${label.toLowerCase()}`; return <div><label className="mb-1.5 block text-xs font-semibold text-[#66796f]" htmlFor={id}>{label}</label><input className="w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-2.5 text-sm" id={id} onChange={(event) => onChange(event.target.value)} type="date" value={value} /></div> }
function EmptyState({ title, description }: { title: string; description: string }) { return <div className="mt-5 rounded-[24px] border border-dashed border-[#cddbc9] bg-white/55 px-6 py-12 text-center"><p className="font-semibold text-[#456356]">{title}</p><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#7a8b82]">{description}</p></div> }
function LoadingBlock() { return <div className="mt-5 rounded-[24px] border border-[#dce6d9] bg-white p-8 text-center text-sm text-[#66796f]" role="status">Cargando tus cuentas…</div> }
