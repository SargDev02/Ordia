import { useLayoutEffect, useRef, useState, type InputHTMLAttributes, type Ref } from 'react'
import { formatCopInput, normalizeCopInput } from '../finance/copInput'

interface CopAmountInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string
  onValueChange: (value: string) => void
  signed?: boolean
  ref?: Ref<HTMLInputElement>
}

export function CopAmountInput({ value, onValueChange, signed = false, ref, ...props }: CopAmountInputProps) {
  const input = useRef<HTMLInputElement>(null)
  const caret = useRef<number | null>(null)
  const [error, setError] = useState('')
  const display = formatCopInput(value, signed)
  useLayoutEffect(() => {
    if (caret.current !== null && input.current === document.activeElement) {
      input.current?.setSelectionRange(caret.current, caret.current)
      caret.current = null
    }
  })

  function change(text: string, position: number, inputType = '', inserted: string | null = null) {
    let normalized = normalizeCopInput(text, signed)
    const editingDigits = /^-?\d*$/.test(value) && (/^(deleteContentBackward|deleteContentForward|deleteByCut)$/.test(inputType)
      || (inputType === 'insertText' && inserted !== null && /^\d+$/.test(inserted)))
    if (editingDigits && /^-?[\d.]*$/.test(text) && (!text.startsWith('-') || signed)) {
      normalized = text.replaceAll('.', '')
    }
    if (normalized === null) {
      setError('Usa pesos enteros: 1.000 o 25.000. No se admiten decimales ni separadores ambiguos.')
      onValueChange(text)
      return
    }
    setError('')
    let digitsBefore = text.slice(0, position).replace(/\D/g, '').length
    // Borrar un separador debe avanzar la edición, no recrear el punto indefinidamente.
    if (inputType.startsWith('deleteContent') && normalized === value && text !== display) {
      const digitIndex = digitsBefore - (inputType === 'deleteContentBackward' ? 1 : 0)
      const sign = normalized.startsWith('-') ? '-' : ''
      const digits = normalized.replace('-', '')
      if (digitIndex >= 0) normalized = sign + digits.slice(0, digitIndex) + digits.slice(digitIndex + 1)
      if (inputType === 'deleteContentBackward') digitsBefore = Math.max(0, digitsBefore - 1)
    }
    const formatted = formatCopInput(normalized, signed)
    let next = formatted.startsWith('-') ? 1 : 0
    for (let count = 0; next < formatted.length && count < digitsBefore; next++) {
      if (/\d/.test(formatted[next])) count++
    }
    caret.current = next
    onValueChange(normalized)
  }

  return <>
    <input {...props} ref={(node) => {
      input.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }} type="text" inputMode="numeric" autoComplete="off" value={display}
      aria-invalid={error ? true : props['aria-invalid']}
      onChange={(event) => change(event.target.value, event.target.selectionStart ?? event.target.value.length, (event.nativeEvent as InputEvent).inputType, (event.nativeEvent as InputEvent).data)}
      onPaste={(event) => {
        event.preventDefault()
        const node = event.currentTarget
        const paste = event.clipboardData.getData('text')
        const accepted = normalizeCopInput(paste, signed)
        // Un pegado completo se valida estrictamente antes de quitar separadores.
        if (accepted === null) { setError('El importe pegado no es un entero COP válido.'); onValueChange(paste); return }
        const before = display.slice(0, node.selectionStart ?? 0).replaceAll('.', '')
        const after = display.slice(node.selectionEnd ?? display.length).replaceAll('.', '')
        change(before + accepted + after, before.length + accepted.length, 'insertFromPaste')
      }} />
    {error && <p className="mt-2 text-xs text-[#9a493e]" role="alert">{error}</p>}
  </>
}

export function CopAmountField({ label, hint, ...props }: CopAmountInputProps & { label: string; hint?: string }) {
  return <div>
    <label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor={props.id}>{label}</label>
    <CopAmountInput {...props} className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5 text-base text-[#173f31] outline-none focus:border-[#4f8068] focus:ring-4 focus:ring-[#4f8068]/10 disabled:bg-[#f0f3ed]" />
    {hint && <p className="mt-2 text-xs leading-5 text-[#718279]">{hint}</p>}
  </div>
}
