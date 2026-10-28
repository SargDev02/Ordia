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
