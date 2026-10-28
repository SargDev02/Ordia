import { supabase } from './supabase'
import type { PersonalTask, TaskInput } from '../types/tasks'

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

export async function fetchTasks() {
  // Paginación estable: no limitar silenciosamente el checklist al máximo de la API.
  const tasks: PersonalTask[] = []
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await client().from('personal_tasks').select('*').is('deleted_at', null).order('id').range(offset, offset + 499)
    if (error) throw new Error('No pudimos cargar tus tareas. Comprueba la conexión y vuelve a intentar.')
    tasks.push(...data as PersonalTask[])
    if (data.length < 500) return tasks
  }
}

export async function saveTask(input: TaskInput, requestId: string, taskId?: string) {
  const result = taskId
    ? await client().from('personal_tasks').update(input).eq('id', taskId).is('deleted_at', null).select().single()
    : await client().rpc('create_personal_task', {
      p_request_id: requestId, p_title: input.title, p_description: input.description,
      p_priority: input.priority, p_estimated_minutes: input.estimated_minutes,
      p_due_on: input.due_on, p_scheduled_at: input.scheduled_at,
    }).single()
  if (result.error) throw new Error('No pudimos guardar la tarea. Revisa los datos y tu conexión; lo escrito se conserva.')
  return result.data as PersonalTask
}

export async function setTaskCompleted(id: string, completed: boolean) {
  const { data, error } = await client().from('personal_tasks').update({ is_completed: completed }).eq('id', id).is('deleted_at', null).select().single()
  if (error) throw new Error('No pudimos cambiar el estado de la tarea. Vuelve a intentar.')
  return data as PersonalTask
}

export async function deleteTask(id: string) {
  const { data, error } = await client().from('personal_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id).is('deleted_at', null).select().single()
  if (error) throw new Error('No pudimos eliminar la tarea. Vuelve a intentar.')
  return data as PersonalTask
}
