import { supabase } from './supabase'
import type { PersonalTask, TaskInput, TaskSchedulingPreferences } from '../types/tasks'

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
  if (result.error) {
    if (result.error.code === '23P01' || result.error.message.includes('task_schedule_overlap')) {
      throw new Error(result.error.details ? `El horario entra en conflicto con la tarea programada: «${result.error.details}».` : 'El horario entra en conflicto con otra tarea programada.')
    }
    throw new Error('No pudimos guardar la tarea. Revisa los datos y tu conexión; lo escrito se conserva.')
  }
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

export async function fetchSchedulingPreferences(userId: string): Promise<TaskSchedulingPreferences | null> {
  const { data, error } = await client()
    .from('task_scheduling_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error('No pudimos cargar tus preferencias de disponibilidad.')
  return data as TaskSchedulingPreferences | null
}

export async function saveSchedulingPreferences(
  preferences: Omit<TaskSchedulingPreferences, 'created_at' | 'updated_at'>,
): Promise<TaskSchedulingPreferences> {
  const { data, error } = await client()
    .from('task_scheduling_preferences')
    .upsert({
      user_id: preferences.user_id,
      buffer_minutes: preferences.buffer_minutes,
      all_day_blocks: preferences.all_day_blocks,
      slots: preferences.slots,
    })
    .select()
    .single()
  if (error) throw new Error('No pudimos guardar tus preferencias de disponibilidad.')
  return data as TaskSchedulingPreferences
}

export async function scheduleTaskWithCheck(
  taskId: string,
  scheduledAt: string | null,
  expectedUpdatedAt: string,
  estimatedMinutes?: number | null,
  acceptUnverifiedCalendars?: boolean,
): Promise<PersonalTask> {
  const { data, error } = await client().rpc('schedule_personal_task', {
    p_task_id: taskId,
    p_scheduled_at: scheduledAt,
    p_expected_updated_at: expectedUpdatedAt,
    p_estimated_minutes: estimatedMinutes ?? null,
    p_accept_unverified_calendars: acceptUnverifiedCalendars ?? false,
  }).single()

  if (error) {
    if (error.code === '40001' || error.message.includes('modified concurrently') || error.message.includes('task_modified')) {
      throw new Error('La tarea fue modificada en otro dispositivo. Hemos actualizado los datos; vuelve a intentar.')
    }
    if (error.message.includes('task_schedule_overlap')) {
      throw new Error(error.details ? `El horario entra en conflicto con la tarea programada: «${error.details}».` : 'El horario entra en conflicto con otra tarea programada.')
    }
    if (error.message.includes('calendar_event_conflict')) {
      throw new Error(error.details ? `El horario entra en conflicto con el evento: «${error.details}».` : 'El horario entra en conflicto con un evento de tu calendario.')
    }
    if (error.code === '55000' || error.message.includes('calendar_unverified')) {
      throw new Error(`No se pudo verificar la disponibilidad completa de tus calendarios (${error.details ?? 'copia desactualizada o con error'}). Actualiza los calendarios antes de programar.`)
    }
    if (error.message.includes('outside_availability') || error.message.includes('availability_required')) {
      throw new Error('El horario seleccionado está fuera de tu disponibilidad configurada.')
    }
    if (error.message.includes('schedule_in_past')) {
      throw new Error('No puedes programar una tarea en el pasado.')
    }
    if (error.message.includes('after_due_date')) {
      throw new Error('El horario programado supera la fecha límite de la tarea.')
    }
    if (error.message.includes('duration_required')) {
      throw new Error('Ingresa una duración estimada positiva para programar la tarea.')
    }
    throw new Error('No pudimos programar la tarea. Comprueba tu conexión y vuelve a intentar.')
  }
  return data as PersonalTask
}
