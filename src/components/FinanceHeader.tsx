import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import type { RealtimeStatus } from '../finance/finance-context'
import { BrandMark } from './BrandMark'

export function FinanceHeader({ realtimeStatus }: { realtimeStatus: RealtimeStatus }) {
  const { session, signOut } = useAuth()
  const location = useLocation()
  const [isSigningOut, setIsSigningOut] = useState(false)

  async function handleSignOut() {
    setIsSigningOut(true)
    await signOut()
  }

  return (
    <header className="border-b border-[#dfe7dc] bg-[#f8faf6]/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-5 sm:px-8 lg:px-12">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <BrandMark />
          <div className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[#d9e3d5] bg-white p-2 pl-4 sm:w-auto">
            <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#789086]">Sesión activa</p><p className="max-w-48 truncate text-sm font-medium text-[#315c49]">{session?.user.email}</p></div>
            <button className="rounded-xl bg-[#edf3ea] px-4 py-2 text-sm font-semibold text-[#315c49] disabled:opacity-60" disabled={isSigningOut} onClick={handleSignOut} type="button">{isSigningOut ? 'Saliendo…' : 'Cerrar sesión'}</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Navegación principal" className="flex max-w-full flex-wrap rounded-xl bg-[#eaf0e7] p-1">
            <Link className={`rounded-lg px-4 py-2 text-sm font-semibold ${location.pathname === '/' ? 'bg-white text-[#173f31] shadow-sm' : 'text-[#557064]'}`} to="/">Resumen</Link>
            <Link className={`rounded-lg px-4 py-2 text-sm font-semibold ${location.pathname === '/gastos-fijos' ? 'bg-white text-[#173f31] shadow-sm' : 'text-[#557064]'}`} to="/gastos-fijos">Gastos fijos</Link>
            <Link className={`rounded-lg px-4 py-2 text-sm font-semibold ${location.pathname === '/tareas' ? 'bg-white text-[#173f31] shadow-sm' : 'text-[#557064]'}`} to="/tareas">Tareas</Link>
            <Link className={`rounded-lg px-4 py-2 text-sm font-semibold ${location.pathname === '/calendario' ? 'bg-white text-[#173f31] shadow-sm' : 'text-[#557064]'}`} to="/calendario">Calendario</Link>
          </nav>
          <div className="flex items-center gap-2 text-xs text-[#66796f]"><span className={`size-2 rounded-full ${realtimeStatus === 'connected' ? 'bg-[#54a675]' : realtimeStatus === 'connecting' ? 'bg-[#d5a747]' : 'bg-[#b66256]'}`} /><span>{realtimeStatus === 'connected' ? 'Sincronización activa' : realtimeStatus === 'connecting' ? 'Conectando…' : 'Sin conexión en tiempo real'}</span></div>
        </div>
      </div>
    </header>
  )
}
