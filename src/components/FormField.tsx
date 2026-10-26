import type { InputHTMLAttributes } from 'react'

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  hint?: string
  label: string
}

export function FormField({ hint, id, label, ...inputProps }: FormFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-[#264a3c]">{label}</label>
      <input
        id={id}
        {...inputProps}
        className="w-full rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5 text-base text-[#173f31] outline-none transition placeholder:text-[#9aa9a1] focus:border-[#4f8068] focus:ring-4 focus:ring-[#4f8068]/10 disabled:cursor-not-allowed disabled:bg-[#f0f3ed]"
      />
      {hint && <p className="mt-2 text-xs leading-5 text-[#718279]">{hint}</p>}
    </div>
  )
}
