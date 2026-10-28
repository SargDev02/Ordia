export type TaskPriority = 'low' | 'medium' | 'high'
export type TaskView = 'pending' | 'scheduled' | 'overdue' | 'completed'

export interface TaskInput {
  title: string
  description: string | null
  priority: TaskPriority
  estimated_minutes: number | null
  due_on: string | null
  scheduled_at: string | null
}

export interface PersonalTask extends TaskInput {
  id: string
  user_id: string
  client_request_id: string
  is_completed: boolean
  completed_at: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface AvailabilitySlot {
  day_of_week: number // 1 = Lunes, ..., 7 = Domingo (ISO)
  start_time: string  // 'HH:mm'
  end_time: string    // 'HH:mm'
}

export interface TaskSchedulingPreferences {
  user_id: string
  buffer_minutes: number
  all_day_blocks: boolean
  slots: AvailabilitySlot[]
  created_at?: string
  updated_at?: string
}

export interface ScheduleProposal {
  start_at: string       // ISO timestamp
  end_at: string         // ISO timestamp
  day_date: string       // YYYY-MM-DD
  day_of_week: number    // 1..7
  duration_minutes: number
  explanation: string    // Motivo breve de la sugerencia
  is_late_reschedule?: boolean
}

export interface TaskSuggestionResult {
  proposals: ScheduleProposal[]
  explanation?: string
  error?: string
}

export interface CalendarCoverageInfo {
  isCovered: boolean
  hasSelectedCalendars: boolean
  lastSyncedAt: string | null
  staleOrError: boolean
  warning?: string
}
