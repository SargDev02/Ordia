import { createContext, useContext } from 'react'
import type { PersonalTask, TaskInput } from '../types/tasks'
import type { RealtimeStatus } from '../finance/finance-context'

export interface TasksState {
  tasks: PersonalTask[]
  isLoading: boolean
  error: string
  realtimeStatus: RealtimeStatus
  refresh: () => Promise<void>
  save: (input: TaskInput, requestId: string, id?: string) => Promise<void>
  complete: (id: string, completed: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const TasksContext = createContext<TasksState | null>(null)

export function useTasks() {
  const context = useContext(TasksContext)
  if (!context) throw new Error('Las tareas necesitan una sesión activa.')
  return context
}
