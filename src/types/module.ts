export type ModuleIcon =
  | 'tasks'
  | 'calendar'
  | 'accounts'
  | 'payments'
  | 'insights'
  | 'notifications'

export interface PlannedModule {
  title: string
  description: string
  icon: ModuleIcon
}
