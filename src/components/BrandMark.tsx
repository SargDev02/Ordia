interface BrandMarkProps {
  compact?: boolean
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className="flex items-center gap-3" aria-label="Ordia">
      <span className="grid size-10 place-items-center rounded-[14px] bg-[#173f31] shadow-[0_8px_24px_rgba(23,63,49,0.18)]">
        <svg viewBox="0 0 24 24" className="size-6 text-[#dff3c9]" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="7.25" stroke="currentColor" strokeWidth="2.5" />
          <path d="M12 7.5V12l3 1.75" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
          <path d="M7.8 18.25h8.4" stroke="#7ac79d" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      </span>
      {!compact && <span className="text-xl font-semibold tracking-[-0.04em] text-[#173f31]">Ordia</span>}
    </div>
  )
}
