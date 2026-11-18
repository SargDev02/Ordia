import { calculateResultTotals, formatCop } from '../finance/calculations'
import type { FinancialTransaction } from '../types/finance'

export function MovementFilterSummary({ rows, accountIds, period, accounts, categories, kind }: {
  rows: FinancialTransaction[]; accountIds: ReadonlySet<string>; period: string; accounts: string; categories: string; kind: string
}) {
  const totals = calculateResultTotals(rows, accountIds)
  return <div className="mt-4 rounded-2xl bg-[#f4f7f1] p-4" aria-label="Resultados del filtro" aria-live="polite">
    <div className="flex flex-wrap gap-2 text-xs text-[#456356]">{[period, accounts, categories, kind].map((text, index) => <span key={index} className="rounded-full border border-[#d6e1d3] bg-white px-3 py-2">{text}</span>)}</div>
    <p className="mt-3 text-sm font-semibold">{rows.length === 1 ? '1 movimiento coincide' : `${rows.length} movimientos coinciden`}</p>
    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">{[['Ingresos del filtro', totals.income], ['Gastos del filtro', totals.expense], ['Diferencia del filtro', totals.difference]].map(([label, amount]) => <div key={String(label)}><dt>{String(label)}</dt><dd className="font-semibold">{formatCop(amount as bigint)}</dd></div>)}</dl>
    <p className="mt-3 text-xs leading-6">Transferencias: entrada {formatCop(totals.transferIn)} · salida {formatCop(totals.transferOut)} · entre cuentas seleccionadas {formatCop(totals.transferInternal)} (una sola vez).</p>
    <p className="text-xs leading-6">Ajustes: aumentos +{formatCop(totals.adjustmentIncrease)} · disminuciones −{formatCop(totals.adjustmentDecrease)}. Transferencias y ajustes no son ingresos ni gastos. Totales de todos los resultados.</p>
  </div>
}
