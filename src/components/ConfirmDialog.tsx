interface ConfirmDialogProps {
  confirmLabel: string
  description: string
  isBusy: boolean
  title: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({ confirmLabel, description, isBusy, title, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#0e2b21]/45 px-5 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-2xl sm:p-8" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
        <h2 className="text-2xl font-semibold tracking-[-0.03em] text-[#173f31]" id="confirm-title">{title}</h2>
        <p className="mt-3 leading-7 text-[#66796f]" id="confirm-description">{description}</p>
        <div className="mt-7 flex justify-end gap-3">
          <button className="rounded-xl border border-[#d5e0d3] px-4 py-2.5 font-semibold text-[#456356]" disabled={isBusy} onClick={onCancel} type="button">Cancelar</button>
          <button className="rounded-xl bg-[#8b3b31] px-4 py-2.5 font-semibold text-white disabled:opacity-60" disabled={isBusy} onClick={onConfirm} type="button">{isBusy ? 'Procesando…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
