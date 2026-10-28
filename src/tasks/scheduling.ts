import { Temporal } from '@js-temporal/polyfill'
import { addCalendarDays, getEventEffectiveRange } from '../calendar/dates'
import { getBogotaToday } from '../finance/calculations'
import type { CalendarEvent } from '../types/calendar'
import type {
  AvailabilitySlot,
  CalendarCoverageInfo,
  PersonalTask,
  ScheduleProposal,
  TaskSchedulingPreferences,
  TaskSuggestionResult,
} from '../types/tasks'

export const DAY_OF_WEEK_LABELS: Record<number, string> = {
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
  7: 'Domingo',
}

export const DEFAULT_AVAILABILITY_SLOTS: AvailabilitySlot[] = [
  { day_of_week: 1, start_time: '09:00', end_time: '12:00' },
  { day_of_week: 1, start_time: '14:00', end_time: '18:00' },
  { day_of_week: 2, start_time: '09:00', end_time: '12:00' },
  { day_of_week: 2, start_time: '14:00', end_time: '18:00' },
  { day_of_week: 3, start_time: '09:00', end_time: '12:00' },
  { day_of_week: 3, start_time: '14:00', end_time: '18:00' },
  { day_of_week: 4, start_time: '09:00', end_time: '12:00' },
  { day_of_week: 4, start_time: '14:00', end_time: '18:00' },
  { day_of_week: 5, start_time: '09:00', end_time: '12:00' },
  { day_of_week: 5, start_time: '14:00', end_time: '18:00' },
]

/**
 * Valida que las franjas horarias sean correctas y que no se superpongan en un mismo día.
 */
export function validateAvailabilitySlots(slots: AvailabilitySlot[]): string | null {
  if (!Array.isArray(slots)) return 'Las franjas deben ser una lista.'
  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/

  for (const slot of slots) {
    if (!Number.isInteger(slot.day_of_week) || slot.day_of_week < 1 || slot.day_of_week > 7) {
      return 'Día de la semana inválido (debe ser de Lunes a Domingo).'
    }
    if (!timeRegex.test(slot.start_time) || !timeRegex.test(slot.end_time)) {
      return 'El formato de hora debe ser HH:mm (24 horas).'
    }
    if (slot.start_time >= slot.end_time) {
      return `La hora de inicio (${slot.start_time}) debe ser anterior a la de fin (${slot.end_time}) en ${DAY_OF_WEEK_LABELS[slot.day_of_week]}.`
    }
  }

  // Validar superposición por día
  for (let day = 1; day <= 7; day++) {
    const daySlots = slots
      .filter((s) => s.day_of_week === day)
      .sort((a, b) => a.start_time.localeCompare(b.start_time))

    for (let i = 0; i < daySlots.length - 1; i++) {
      const current = daySlots[i]
      const next = daySlots[i + 1]
      if (current.end_time > next.start_time) {
        return `Las franjas de ${DAY_OF_WEEK_LABELS[day]} no pueden superponerse (${current.start_time}–${current.end_time} y ${next.start_time}–${next.end_time}).`
      }
    }
  }

  return null
}

/**
 * Ordena tareas pendientes sin programar para la vista de planificación:
 * 1. Próximas a vencer (due_on más cercano, vencidas primero, tareas sin vencimiento al final).
 * 2. Prioridad (alta > media > baja).
 * 3. Título / ID estable.
 */
export function sortTasksForPlanning(tasks: PersonalTask[], _today?: string): PersonalTask[] {
  const priorityRank = { high: 0, medium: 1, low: 2 }
  return tasks
    .filter((task) => !task.deleted_at && !task.is_completed && !task.scheduled_at)
    .sort((a, b) => {
      // due_on ascendente; tareas sin vencimiento al final ('9999-12-31')
      const dueA = a.due_on ?? '9999-12-31'
      const dueB = b.due_on ?? '9999-12-31'
      const dueDiff = dueA.localeCompare(dueB)
      if (dueDiff !== 0) return dueDiff

      const prioDiff = priorityRank[a.priority] - priorityRank[b.priority]
      if (prioDiff !== 0) return prioDiff

      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    })
}

export interface ProviderCoverageCheck {
  connected: boolean
  hasSelected: boolean
  error: string | null
  syncedAt: string | null
  windowCovered: boolean
}

/**
 * Comprueba si la sincronización cubre los 7 días y la salud de los proveedores.
 */
export function checkCalendarCoverage(
  _today: string,
  icloud: ProviderCoverageCheck,
  google: ProviderCoverageCheck,
  now = new Date(),
): CalendarCoverageInfo {
  const anyConnected = icloud.connected || google.connected
  const anySelected = icloud.hasSelected || google.hasSelected

  if (!anyConnected || !anySelected) {
    return {
      isCovered: true,
      hasSelectedCalendars: false,
      lastSyncedAt: null,
      staleOrError: false,
      warning: 'Sin calendarios externos seleccionados. Las sugerencias se basan en tu disponibilidad y tareas de Ordia.',
    }
  }

  const providers = [
    { label: 'iCloud', check: icloud },
    { label: 'Google', check: google },
  ].filter((p) => p.check.hasSelected)

  let staleOrError = false
  let isCovered = true
  const warnings: string[] = []
  let latestSync: string | null = null

  const oneDayAgo = now.getTime() - 24 * 60 * 60 * 1000

  for (const { label, check } of providers) {
    if (check.syncedAt) {
      if (!latestSync || check.syncedAt > latestSync) latestSync = check.syncedAt
      if (Date.parse(check.syncedAt) < oneDayAgo) {
        staleOrError = true
        warnings.push(`La copia de ${label} tiene más de 24 horas.`)
      }
    } else {
      staleOrError = true
      warnings.push(`Sin copia sincronizada para ${label}.`)
    }

    if (check.error) {
      staleOrError = true
      warnings.push(`${label}: ${check.error}`)
    }

    if (!check.windowCovered) {
      isCovered = false
      warnings.push(`El rango de 7 días no está completamente cubierto en ${label}.`)
    }
  }

  return {
    isCovered,
    hasSelectedCalendars: true,
    lastSyncedAt: latestSync,
    staleOrError,
    warning: warnings.length > 0 ? warnings.join(' ') : undefined,
  }
}

interface BusyInterval {
  startMs: number
  endMs: number
  title?: string
}

/**
 * Une intervalos superpuestos o contiguos ordenados cronológicamente.
 */
export function mergeBusyIntervals(intervals: BusyInterval[]): BusyInterval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  const merged: BusyInterval[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]
    const last = merged[merged.length - 1]
    if (current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs)
    } else {
      merged.push(current)
    }
  }
  return merged
}

export interface TaskSuggestionParams {
  task: PersonalTask
  preferences: TaskSchedulingPreferences | null
  externalEvents: CalendarEvent[]
  scheduledTasks: PersonalTask[]
  now?: Date
  today?: string
}

/**
 * Motor determinista de sugerencias de horarios para tareas.
 * Busca hasta 3 alternativas dentro de los próximos 7 días respetando:
 * - Disponibilidad del usuario
 * - Margen entre compromisos
 * - Eventos de calendario y tareas ya programadas
 * - Fecha límite (due_on) o reprogramación tardía si está vencida
 */
export function generateTaskSuggestions({
  task,
  preferences,
  externalEvents,
  scheduledTasks,
  now = new Date(),
  today = getBogotaToday(now),
}: TaskSuggestionParams): TaskSuggestionResult {
  if (!preferences || preferences.slots.length === 0) {
    return {
      proposals: [],
      error: 'no_availability',
      explanation: 'Configura tu disponibilidad personal para generar sugerencias.',
    }
  }

  const duration = task.estimated_minutes
  if (!duration || duration <= 0 || !Number.isInteger(duration)) {
    return {
      proposals: [],
      error: 'missing_duration',
      explanation: 'Ingresa una duración estimada positiva para recibir sugerencias de horario.',
    }
  }

  const durationMs = duration * 60 * 1000
  const bufferMs = preferences.buffer_minutes * 60 * 1000
  const nowMs = now.getTime()

  // 1. Recolectar intervalos ocupados
  const rawBusy: BusyInterval[] = []

  // El pasado hasta (now + buffer) está ocupado
  rawBusy.push({ startMs: 0, endMs: nowMs + bufferMs })

  // Eventos externos con horario (excluyendo cancelados o transparentes si estuvieran marcados)
  for (const event of externalEvents) {
    if (event.all_day) continue // Se manejan por día si all_day_blocks está activo
    const range = getEventEffectiveRange(event)
    if (!range.isValid) continue
    // Regla conservadora: eventos con horario bloquean el tiempo
    rawBusy.push({
      startMs: range.startMs - bufferMs,
      endMs: range.endMs + bufferMs,
      title: event.title,
    })
  }

  // Tareas ya programadas
  for (const scheduled of scheduledTasks) {
    if (scheduled.id === task.id || scheduled.deleted_at || scheduled.is_completed || !scheduled.scheduled_at) {
      continue
    }
    const schedStart = Date.parse(scheduled.scheduled_at)
    if (Number.isNaN(schedStart)) continue

    // Si la tarea programada no tiene duración estimada, aplicar regla conservadora (al menos 30 min o buffer)
    const schedDuration = (scheduled.estimated_minutes && scheduled.estimated_minutes > 0)
      ? scheduled.estimated_minutes
      : 30
    const schedEnd = schedStart + schedDuration * 60 * 1000

    rawBusy.push({
      startMs: schedStart - bufferMs,
      endMs: schedEnd + bufferMs,
      title: scheduled.title,
    })
  }

  const mergedBusy = mergeBusyIntervals(rawBusy)

  // 2. Revisar los próximos 7 días
  const proposals: ScheduleProposal[] = []
  const isOverdue = !!task.due_on && task.due_on < today
  let hitDueDateLimit = false

  for (let dayOffset = 0; dayOffset < 7 && proposals.length < 3; dayOffset++) {
    const dayDate = addCalendarDays(today, dayOffset)

    // Si la tarea tiene fecha límite y no está vencida previamente, no sugerir horarios posteriores al final de ese día
    if (task.due_on && !isOverdue && dayDate > task.due_on) {
      hitDueDateLimit = true
      break
    }

    // Verificar si eventos de todo el día bloquean este día
    if (preferences.all_day_blocks) {
      const hasAllDayEvent = externalEvents.some((event) => {
        if (!event.all_day) return false
        const range = getEventEffectiveRange(event)
        return range.isValid && range.startOn! <= dayDate && range.endOn! > dayDate
      })
      if (hasAllDayEvent) {
        continue // Todo el día bloqueado
      }
    }

    const dateVal = Temporal.PlainDate.from(dayDate)
    const dayOfWeek = dateVal.dayOfWeek // 1=Lunes .. 7=Domingo

    // Franjas configuradas para este día
    const daySlots = preferences.slots
      .filter((s) => s.day_of_week === dayOfWeek)
      .sort((a, b) => a.start_time.localeCompare(b.start_time))

    for (const slot of daySlots) {
      if (proposals.length >= 3) break

      const slotStartMs = dateVal.toZonedDateTime({ timeZone: 'America/Bogota', plainTime: slot.start_time }).epochMilliseconds
      const slotEndMs = dateVal.toZonedDateTime({ timeZone: 'America/Bogota', plainTime: slot.end_time }).epochMilliseconds

      // Punto de partida efectivo dentro de la franja (no sugerir en el pasado)
      let cursor = Math.max(slotStartMs, nowMs + bufferMs)

      while (cursor + durationMs <= slotEndMs && proposals.length < 3) {
        // Encontrar si el intervalo [cursor, cursor + durationMs] choca con algún ocupado
        const targetEnd = cursor + durationMs
        const conflictingBusy = mergedBusy.find((b) => b.startMs < targetEnd && b.endMs > cursor)

        if (!conflictingBusy) {
          // Espacio libre encontrado!
          const proposalStart = new Date(cursor).toISOString()
          const proposalEnd = new Date(targetEnd).toISOString()

          let explanation = ''
          if (isOverdue) {
            explanation = `Reprogramación tardía (venció el ${task.due_on}): espacio disponible en tu franja de ${slot.start_time} a ${slot.end_time}.`
          } else if (dayDate === today) {
            explanation = `Hoy, primer espacio disponible en tu franja de ${slot.start_time} a ${slot.end_time}.`
          } else if (dayDate === addCalendarDays(today, 1)) {
            explanation = `Mañana, espacio disponible en tu franja de ${slot.start_time} a ${slot.end_time}.`
          } else {
            explanation = `${DAY_OF_WEEK_LABELS[dayOfWeek]} ${dayDate}, espacio disponible en tu franja de ${slot.start_time} a ${slot.end_time}.`
          }

          proposals.push({
            start_at: proposalStart,
            end_at: proposalEnd,
            day_date: dayDate,
            day_of_week: dayOfWeek,
            duration_minutes: duration,
            explanation,
            is_late_reschedule: isOverdue,
          })

          // Avanzar cursor al fin del bloque programado para buscar siguientes alternativas
          cursor = targetEnd + bufferMs
        } else {
          // Saltar después del bloque ocupado
          cursor = Math.max(cursor + 15 * 60 * 1000, conflictingBusy.endMs)
        }
      }
    }
  }

  if (proposals.length === 0) {
    let explanation = `No hay espacios libres continuos de ${duration} minutos en tu disponibilidad configurada para los próximos 7 días.`
    if (hitDueDateLimit && task.due_on) {
      explanation = `No se encontraron espacios de ${duration} minutos antes de la fecha límite (${task.due_on}). Puedes ampliar el vencimiento o ajustar tu disponibilidad.`
    }
    return {
      proposals: [],
      explanation,
    }
  }

  return { proposals }
}

/**
 * Detecta si una tarea programada tiene conflicto con algún evento de calendario externo.
 */
export function detectTaskConflict(
  task: PersonalTask,
  externalEvents: CalendarEvent[],
  bufferMinutes = 0,
): CalendarEvent | null {
  if (!task.scheduled_at || task.is_completed || task.deleted_at) return null
  const taskStart = Date.parse(task.scheduled_at)
  if (Number.isNaN(taskStart)) return null
  const duration = task.estimated_minutes && task.estimated_minutes > 0 ? task.estimated_minutes : 30
  const taskEnd = taskStart + duration * 60 * 1000
  const bufferMs = bufferMinutes * 60 * 1000

  for (const event of externalEvents) {
    if (event.all_day) continue
    const range = getEventEffectiveRange(event)
    if (!range.isValid) continue
    if (range.startMs - bufferMs < taskEnd && range.endMs + bufferMs > taskStart) {
      return event
    }
  }
  return null
}
