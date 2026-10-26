import { useEffect, useId, useRef, type ReactNode } from 'react'

interface FormDialogProps {
  children: ReactNode
  title: string
  onClose: () => void
}

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function FormDialog({ children, title, onClose }: FormDialogProps) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)

  function requestClose() {
    onClose()
  }

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusTarget = dialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      ?? dialogRef.current?.querySelector<HTMLElement>(focusableSelector)
    focusTarget?.focus()

    return () => {
      document.body.style.overflow = previousOverflow
      returnFocusRef.current?.focus()
    }
  }, [])

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#0e2b21]/50 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="max-h-[100dvh] w-full overflow-y-auto overscroll-contain rounded-t-[30px] bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)] sm:max-w-2xl sm:rounded-[30px]"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 className="sr-only" id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  )
}
