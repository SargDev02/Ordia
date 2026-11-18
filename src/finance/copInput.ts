export function normalizeCopInput(text: string, signed = false): string | null {
  const value = text.trim().replace(/^\$\s*/, '')
  if (!value || (signed && value === '-')) return value
  const sign = signed && value.startsWith('-') ? '-' : ''
  const digits = sign ? value.slice(1) : value
  if (!/^\d+$/.test(digits) && !/^\d{1,3}(\.\d{3})+$/.test(digits)) return null
  return sign + digits.replaceAll('.', '')
}

export function formatCopInput(raw: string, signed = false): string {
  if (normalizeCopInput(raw, signed) !== raw) return raw
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
