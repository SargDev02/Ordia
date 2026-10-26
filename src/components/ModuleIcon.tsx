import type { ReactNode } from 'react'
import type { ModuleIcon as ModuleIconName } from '../types/module'

interface ModuleIconProps {
  name: ModuleIconName
}

export function ModuleIcon({ name }: ModuleIconProps) {
  const paths: Record<ModuleIconName, ReactNode> = {
    tasks: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></>,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /><path d="M8 14h3v3H8z" /></>,
    accounts: <><rect x="3" y="6" width="18" height="14" rx="3" /><path d="M16 13h5M7 6V4h10v2" /><circle cx="16" cy="13" r=".7" fill="currentColor" /></>,
    payments: <><path d="M7 3h10a2 2 0 0 1 2 2v16l-3-2-4 2-4-2-3 2V5a2 2 0 0 1 2-2Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
    insights: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2" /><path d="m4 6 5-3 6 5 5-4" /></>,
    notifications: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  }

  return (
    <svg className="size-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}
