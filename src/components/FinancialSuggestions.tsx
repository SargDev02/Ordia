import { Link } from 'react-router-dom'
import type { FinancialSuggestionsResult } from '../finance/suggestions'
import { formatCop } from '../finance/calculations'

interface FinancialSuggestionsProps {
  suggestions: FinancialSuggestionsResult
}

export function FinancialSuggestions({ suggestions }: FinancialSuggestionsProps) {
  const {
    hasAccountsSelected,
    scope,
    overdueNotice,
    insufficientBalanceNotices,
    upcomingPaymentsNotice,
    expenseComparisonNotice,
    cashFlowSummaryNotice,
    emptyReason,
  } = suggestions

  const scopeLabel = scope.isAllAccounts
    ? `Todas las cuentas (${scope.accountCount})`
    : `${scope.accountCount} cuenta${scope.accountCount === 1 ? '' : 's'} (${scope.accountNames.join(', ')})`

  return (
    <section
      aria-labelledby="financial-suggestions-title"
      className="mt-8 rounded-[24px] border border-[#dce6d9] bg-white p-5 sm:p-6"
      id="sugerencias-financieras"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-[#173f31]" id="financial-suggestions-title">
            Sugerencias y análisis financiero
          </h2>
          <p className="mt-1 text-sm text-[#66796f]">
            Observaciones factuales y deterministas basadas exclusivamente en los movimientos y obligaciones registrados en Ordia.
          </p>
        </div>
        {hasAccountsSelected && (
          <span className="self-start rounded-full bg-[#edf3ea] px-3 py-1 text-xs font-semibold text-[#315c49]">
            Alcance: {scopeLabel}
          </span>
        )}
      </div>

      {/* Estado vacío: Sin cuentas seleccionadas */}
      {!hasAccountsSelected || emptyReason === 'no_accounts' ? (
        <div className="mt-5 rounded-2xl border border-dashed border-[#c6d7c3] bg-[#f8faf6] p-6 text-center">
          <p className="font-semibold text-[#264a3c]">Selecciona cuentas para ver sugerencias</p>
          <p className="mt-2 text-sm text-[#66796f]">
            Selecciona una o varias cuentas en los filtros superiores o pulsa «Todas» para generar el resumen y sugerencias financieras.
          </p>
        </div>
      ) : emptyReason === 'no_data' ? (
        <div className="mt-5 rounded-2xl border border-dashed border-[#c6d7c3] bg-[#f8faf6] p-6 text-center">
          <p className="font-semibold text-[#264a3c]">Sin datos suficientes en este alcance</p>
          <p className="mt-2 text-sm text-[#66796f]">
            No hay movimientos ni obligaciones registrados en las cuentas seleccionadas para el período actual ({scope.periodStart} a {scope.periodEnd}). Registra ingresos, gastos o gastos fijos para habilitar comparaciones y proyecciones.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {/* 1. ATENCIÓN PRIORITARIA: OBLIGACIONES VENCIDAS */}
          {overdueNotice && (
            <article
              aria-label="Aviso de obligaciones vencidas"
              className="rounded-2xl border border-[#f2d3cc] bg-[#fdf4f2] p-4 sm:p-5"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-[#9a493e] px-2.5 py-0.5 text-xs font-semibold text-white">
                      Atención requerida
                    </span>
                    <h3 className="font-semibold text-[#8b3d32]">{overdueNotice.title}</h3>
                  </div>
                  <p className="mt-2 text-sm text-[#73352c]">{overdueNotice.description}</p>
                </div>
                <Link
                  className="inline-flex shrink-0 items-center justify-center rounded-xl bg-[#8b3d32] px-4 py-2 text-xs font-semibold text-white hover:bg-[#73352c]"
                  to="/gastos-fijos"
                >
                  Gestionar en Gastos fijos
                </Link>
              </div>

              <div className="mt-4 divide-y divide-[#fadcd6] rounded-xl bg-white/70 p-3">
                {overdueNotice.items.map((item) => (
                  <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs first:pt-0 last:pb-0" key={item.periodId}>
                    <div className="min-w-0">
                      <span className="font-semibold text-[#401d18]">{item.name}</span>
                      <span className="ml-2 text-[#8b554d]">Venció: {item.dueDate}</span>
                      {item.suggestedAccountName ? (
                        <span className="ml-2 text-[#73352c]">· Cuenta sugerida: {item.suggestedAccountName}</span>
                      ) : (
                        <span className="ml-2 font-medium text-[#8b554d]">· (Sin cuenta sugerida asignada)</span>
                      )}
                    </div>
                    <span className="font-semibold text-[#9a493e]">{formatCop(item.expectedAmount)}</span>
                  </div>
                ))}
              </div>
            </article>
          )}

          {/* 2. ATENCIÓN PRIORITARIA: SALDO INSUFICIENTE PARA PAGOS PRÓXIMOS */}
          {insufficientBalanceNotices.map((notice) => (
            <article
              aria-label={`Aviso de saldo insuficiente en ${notice.accountName}`}
              className="rounded-2xl border border-[#fed7aa] bg-[#fffaf5] p-4 sm:p-5"
              key={notice.accountId}
            >
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-[#c25e00] px-2.5 py-0.5 text-xs font-semibold text-white">
                  Saldo insuficiente
                </span>
                <h3 className="font-semibold text-[#934500]">
                  {notice.accountName}: pagos pendientes superan el saldo registrado
                </h3>
              </div>
              <p className="mt-2 text-sm text-[#7a3e08]">{notice.description}</p>

              <div className="mt-3 grid gap-2 sm:grid-cols-3 text-xs">
                <div className="rounded-xl bg-white p-3 border border-[#fed7aa]/60">
                  <p className="text-[#8a4b16]">Saldo registrado actual</p>
                  <p className="mt-1 text-base font-semibold text-[#173f31]">{formatCop(notice.currentBalance)}</p>
                </div>
                <div className="rounded-xl bg-white p-3 border border-[#fed7aa]/60">
                  <p className="text-[#8a4b16]">Vencidos y próximos 7 días</p>
                  <p className="mt-1 text-base font-semibold text-[#934500]">{formatCop(notice.requiredAmount)}</p>
                </div>
                <div className="rounded-xl bg-white p-3 border border-[#fed7aa]/60">
                  <p className="text-[#8a4b16]">Déficit estimado</p>
                  <p className="mt-1 text-base font-semibold text-[#c25e00]">Faltan {formatCop(notice.deficitAmount)}</p>
                </div>
              </div>

              {notice.items.length > 0 && (
                <div className="mt-3 divide-y divide-[#fed7aa]/50 rounded-xl bg-white/70 p-3 text-xs">
                  {notice.items.map((item) => (
                    <div className="flex justify-between py-1.5 first:pt-0 last:pb-0" key={item.periodId}>
                      <span className="text-[#7a3e08]">
                        {item.name} ({item.isOverdue ? `venció: ${item.dueDate}` : `vence: ${item.dueDate}`})
                      </span>
                      <span className="font-semibold text-[#934500]">{formatCop(item.expectedAmount)}</span>
                    </div>
                  ))}
                </div>
              )}

              <p className="mt-3 text-[11px] leading-4 text-[#8a5b29]">
                Cálculo basado exclusivamente en el saldo actual registrado frente a las obligaciones impagas vencidas y las próximas entre {notice.windowStart} y {notice.windowEnd}. Ordia no anticipa ingresos futuros ni mueve dinero automáticamente.
              </p>
            </article>
          ))}

          {/* 3. PAGOS PRÓXIMOS EN LOS PRÓXIMOS 7 DÍAS */}
          {upcomingPaymentsNotice && (
            <article className="rounded-2xl border border-[#dce6d9] bg-[#f8faf6] p-4 sm:p-5">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="font-semibold text-[#173f31]">
                    Pagos próximos ({upcomingPaymentsNotice.windowStart} a {upcomingPaymentsNotice.windowEnd})
                  </h3>
                  <p className="mt-0.5 text-xs text-[#66796f]">
                    {upcomingPaymentsNotice.description}
                  </p>
                </div>
                <span className="text-base font-semibold text-[#264a3c]">
                  Total: {formatCop(upcomingPaymentsNotice.totalAmount)}
                </span>
              </div>

              {/* Cuentas con saldo suficiente para sus compromisos */}
              {upcomingPaymentsNotice.coveredAccounts.length > 0 && (
                <div className="mt-3 space-y-2">
                  {upcomingPaymentsNotice.coveredAccounts.map((covered) => (
                    <div
                      className="rounded-xl border border-[#e1ece0] bg-white p-3 text-xs"
                      key={covered.accountId}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-[#264a3c]">{covered.accountName}</span>
                        <span className="text-[#4f8068]">
                          Saldo registrado: {formatCop(covered.currentBalance)} · Compromisos: {formatCop(covered.commitmentsAmount)}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11px] text-[#66796f]">
                        Saldo restante estimado tras estos pagos: <strong className="text-[#173f31]">{formatCop(covered.remainingEstimatedBalance)}</strong>. Aclaración: esta diferencia se basa estrictamente en el saldo registrado actual; no constituye dinero garantizado para gastar libremente ni prevé imprevistos futuros.
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Obligaciones sin cuenta sugerida asignada */}
              {upcomingPaymentsNotice.unassignedItems.length > 0 && (
                <div className="mt-3 rounded-xl border border-[#fed7aa]/50 bg-[#fffcf7] p-3 text-xs">
                  <p className="font-semibold text-[#934500]">
                    {upcomingPaymentsNotice.unassignedItems.length} pago{upcomingPaymentsNotice.unassignedItems.length === 1 ? '' : 's'} sin cuenta sugerida asignada ({formatCop(upcomingPaymentsNotice.unassignedTotalAmount)}):
                  </p>
                  <ul className="mt-1.5 space-y-1 text-[#7a3e08]">
                    {upcomingPaymentsNotice.unassignedItems.map((item) => (
                      <li key={item.periodId} className="flex justify-between">
                        <span>{item.name} (vence: {item.dueDate})</span>
                        <span className="font-semibold">{formatCop(item.expectedAmount)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-[#8a5b29]">
                    {!scope.isAllAccounts
                      ? `Filtro de cuentas activo (${scope.accountNames.join(', ')}): estas obligaciones no tienen cuenta asignada ni se debitan de las cuentas seleccionadas; verifica qué cuenta utilizarás para cubrirlas.`
                      : 'Estas obligaciones no se debitan de ninguna cuenta automáticamente; verifica desde qué cuenta planeas realizarlas.'}
                  </p>
                </div>
              )}
            </article>
          )}

          {/* 4. COMPARACIÓN DE GASTOS Y CATEGORÍAS PRINCIPALES */}
          {expenseComparisonNotice && (
            <article className="rounded-2xl border border-[#dce6d9] bg-white p-4 sm:p-5">
              <h3 className="font-semibold text-[#173f31]">
                Análisis de gastos frente al mes anterior
              </h3>
              <p className="mt-1 text-sm text-[#4f6458]">
                {expenseComparisonNotice.description}
              </p>
              <p className="mt-1 text-xs text-[#829188]">
                {expenseComparisonNotice.adjustmentExplanation}
              </p>

              {/* Métricas comparativas */}
              <div className="mt-4 grid gap-3 sm:grid-cols-2 text-xs">
                <div className="rounded-xl border border-[#e5ebe2] bg-[#f8faf6] p-3">
                  <p className="text-[#66796f]">
                    Gastos en el mes actual ({expenseComparisonNotice.currentPeriod.start} a {expenseComparisonNotice.currentPeriod.end})
                  </p>
                  <p className="mt-1.5 text-lg font-semibold text-[#173f31]">
                    {formatCop(expenseComparisonNotice.currentPeriod.expense)}
                  </p>
                </div>
                <div className="rounded-xl border border-[#e5ebe2] bg-[#f8faf6] p-3">
                  <p className="text-[#66796f]">
                    Mismo período de {expenseComparisonNotice.previousPeriod.monthName} {expenseComparisonNotice.previousPeriod.year} ({expenseComparisonNotice.previousPeriod.start} a {expenseComparisonNotice.previousPeriod.end})
                  </p>
                  <p className="mt-1.5 text-lg font-semibold text-[#173f31]">
                    {formatCop(expenseComparisonNotice.previousPeriod.expense)}
                  </p>
                </div>
              </div>

              {/* Categorías con mayor gasto */}
              {expenseComparisonNotice.topCategories.length > 0 && (
                <div className="mt-4 border-t border-[#edf2ea] pt-3">
                  <p className="text-xs font-semibold text-[#4f8068]">
                    Categorías con mayor gasto registrado a la fecha (subcategorías agrupadas):
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    {expenseComparisonNotice.topCategories.map((cat) => (
                      <div className="rounded-xl border border-[#e5ebe2] bg-[#fcfdfa] p-2.5 text-xs" key={cat.categoryId}>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold truncate text-[#264a3c]">{cat.categoryName}</span>
                          <span className="ml-1 rounded-full bg-[#edf3ea] px-1.5 py-0.2 text-[10px] font-semibold text-[#4f8068]">
                            {cat.percentage}%
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-semibold text-[#173f31]">
                          {formatCop(cat.amount)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-3 text-[11px] leading-4 text-[#8a9990]">
                Información estrictamente descriptiva basada en los movimientos registrados en las cuentas seleccionadas. La ausencia de movimientos no presume ausencia de gastos reales no registrados en Ordia.
              </p>
            </article>
          )}

          {/* 5. RESUMEN DE FLUJO NETO (INGRESOS VS GASTOS) */}
          {cashFlowSummaryNotice && (
            <article className="rounded-2xl border border-[#dce6d9] bg-[#f8faf6] p-4 sm:p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="font-semibold text-[#173f31]">
                    Flujo neto del período ({cashFlowSummaryNotice.periodStart} a {cashFlowSummaryNotice.periodEnd})
                  </h3>
                  <p className="mt-1 text-sm text-[#4f6458]">
                    {cashFlowSummaryNotice.description}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-[#66796f]">Diferencia (Ingresos − Gastos)</p>
                  <p
                    className={`text-lg font-semibold ${
                      cashFlowSummaryNotice.net > 0n
                        ? 'text-[#2f7650]'
                        : cashFlowSummaryNotice.net < 0n
                          ? 'text-[#9a493e]'
                          : 'text-[#173f31]'
                    }`}
                  >
                    {cashFlowSummaryNotice.net > 0n ? '+' : ''}
                    {formatCop(cashFlowSummaryNotice.net)}
                  </p>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-4 text-xs text-[#718279]">
                <span>Ingresos registrados: <strong className="text-[#2f7650]">{formatCop(cashFlowSummaryNotice.income)}</strong></span>
                <span>Gastos registrados: <strong className="text-[#9a493e]">{formatCop(cashFlowSummaryNotice.expense)}</strong></span>
                <span>(Excluye transferencias entre cuentas y saldos iniciales)</span>
              </div>
            </article>
          )}
        </div>
      )}
    </section>
  )
}
