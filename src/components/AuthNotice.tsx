interface AuthNoticeProps {
  children: string
  tone: 'error' | 'success' | 'info'
}

const toneClasses = {
  error: 'border-[#edcfca] bg-[#fff4f2] text-[#8b3b31]',
  info: 'border-[#cedfd6] bg-[#eef6f1] text-[#315c49]',
  success: 'border-[#c9dfcd] bg-[#f0f8f0] text-[#2f6542]',
}

export function AuthNotice({ children, tone }: AuthNoticeProps) {
  return (
    <div className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${toneClasses[tone]}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  )
}
