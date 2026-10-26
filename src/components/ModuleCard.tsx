import type { PlannedModule } from '../types/module'
import { ModuleIcon } from './ModuleIcon'

interface ModuleCardProps {
  module: PlannedModule
}

export function ModuleCard({ module }: ModuleCardProps) {
  return (
    <article className="group flex min-h-64 flex-col rounded-[28px] border border-[#dfe7dc] bg-white p-6 shadow-[0_1px_1px_rgba(23,63,49,0.02)] transition-transform duration-300 hover:-translate-y-1 sm:p-7">
      <div className="mb-10 flex items-start justify-between gap-4">
        <span className="grid size-12 place-items-center rounded-2xl bg-[#edf5e8] text-[#2f674f]">
          <ModuleIcon name={module.icon} />
        </span>
        <span className="rounded-full border border-[#dce7d8] bg-[#f8faf6] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#62786c]">
          Pendiente
        </span>
      </div>
      <div className="mt-auto">
        <h3 className="text-xl font-semibold tracking-[-0.03em] text-[#173f31]">{module.title}</h3>
        <p className="mt-3 text-sm leading-6 text-[#66796f]">{module.description}</p>
      </div>
    </article>
  )
}
