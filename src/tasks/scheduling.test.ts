import { describe, expect, it } from 'vitest'
import {
  checkCalendarCoverage,
  detectTaskConflict,
  generateTaskSuggestions,
  mergeBusyIntervals,
  sortTasksForPlanning,
  validateAvailabilitySlots,
} from './scheduling'
import type { CalendarEvent } from '../types/calendar'
import type { AvailabilitySlot, PersonalTask, TaskSchedulingPreferences } from '../types/tasks'

const createTask = (input: Partial<PersonalTask>): PersonalTask => ({
  id: 't-1',
  user_id: 'u-1',
  client_request_id: 'req-1',
  title: 'Tarea de prueba',
  description: '',
  priority: 'medium',
  estimated_minutes: 60,
  due_on: null,
  scheduled_at: null,
  is_completed: false,
  completed_at: null,
  deleted_at: null,
  created_at: '2026-10-27T10:00:00Z',
  updated_at: '2026-10-27T10:00:00Z',
  ...input,
})

const createEvent = (input: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'ev-1',
  user_id: 'u-1',
  calendar_id: 'cal-1',
  window_id: 'w-1',
  occurrence_key: 'o-1',
  title: 'Evento',
  description: '',
  location: '',
  url: null,
  all_day: false,
  starts_at: null,
  ends_at: null,
  start_on: null,
  end_on: null,
  ...input,
})

describe('validación de franjas de disponibilidad personal', () => {
  it('acepta franjas válidas para mañana y tarde en el mismo día sin superposición', () => {
    const slots: AvailabilitySlot[] = [
      { day_of_week: 1, start_time: '08:00', end_time: '12:00' },
      { day_of_week: 1, start_time: '14:00', end_time: '18:00' },
    ]
    expect(validateAvailabilitySlots(slots)).toBeNull()
  })

  it('rechaza franjas que se superponen en el mismo día', () => {
    const overlapping: AvailabilitySlot[] = [
      { day_of_week: 1, start_time: '09:00', end_time: '13:00' },
      { day_of_week: 1, start_time: '12:30', end_time: '17:00' },
    ]
    const error = validateAvailabilitySlots(overlapping)
    expect(error).toContain('no pueden superponerse')
    expect(error).toContain('Lunes')
  })

  it('rechaza franjas con hora de inicio mayor o igual a la de fin', () => {
    const invalid: AvailabilitySlot[] = [
      { day_of_week: 2, start_time: '15:00', end_time: '14:00' },
    ]
    expect(validateAvailabilitySlots(invalid)).toContain('debe ser anterior a la de fin')
  })
})

describe('ordenación de tareas para la vista de planificación', () => {
  it('ordena por vencimiento próximo (vencidas primero), luego por prioridad y título', () => {
    const today = '2026-10-27'
    const overdue = createTask({ id: 'overdue', title: 'Vencida ayer', due_on: '2026-10-26', priority: 'low' })
    const dueTodayHigh = createTask({ id: 'today-high', title: 'Hoy urgente', due_on: '2026-10-27', priority: 'high' })
    const dueTodayLow = createTask({ id: 'today-low', title: 'Hoy baja', due_on: '2026-10-27', priority: 'low' })
    const dueTomorrow = createTask({ id: 'tomorrow', title: 'Mañana', due_on: '2026-10-28', priority: 'high' })
    const noDue = createTask({ id: 'no-due', title: 'Sin fecha', due_on: null, priority: 'high' })

    const list = [noDue, dueTomorrow, dueTodayLow, overdue, dueTodayHigh]
    const sorted = sortTasksForPlanning(list, today)

    expect(sorted.map((t) => t.id)).toEqual([
      'overdue',
      'today-high',
      'today-low',
      'tomorrow',
      'no-due',
    ])
  })
})

describe('fusión de intervalos ocupados', () => {
  it('combina intervalos superpuestos o contiguos', () => {
    const intervals = [
      { startMs: 1000, endMs: 2000 },
      { startMs: 1500, endMs: 2500 },
      { startMs: 3000, endMs: 4000 },
      { startMs: 4000, endMs: 5000 },
    ]
    const merged = mergeBusyIntervals(intervals)
    expect(merged).toEqual([
      { startMs: 1000, endMs: 2500 },
      { startMs: 3000, endMs: 5000 },
    ])
  })
})

describe('motor de sugerencias determinista', () => {
  const today = '2026-10-27' // Martes (day_of_week = 2)
  const now = new Date('2026-10-27T08:00:00-05:00') // 13:00 UTC

  const basePreferences: TaskSchedulingPreferences = {
    user_id: 'u-1',
    buffer_minutes: 15,
    all_day_blocks: true,
    slots: [
      { day_of_week: 2, start_time: '09:00', end_time: '12:00' }, // Martes hoy mañana
      { day_of_week: 2, start_time: '14:00', end_time: '18:00' }, // Martes hoy tarde
      { day_of_week: 3, start_time: '09:00', end_time: '12:00' }, // Miércoles mañana
    ],
  }

  it('requiere disponibilidad configurada y duración positiva', () => {
    const task = createTask({ estimated_minutes: 60 })
    const noAvail = generateTaskSuggestions({ task, preferences: null, externalEvents: [], scheduledTasks: [], now, today })
    expect(noAvail.error).toBe('no_availability')

    const noDurationTask = createTask({ estimated_minutes: null })
    const noDur = generateTaskSuggestions({ task: noDurationTask, preferences: basePreferences, externalEvents: [], scheduledTasks: [], now, today })
    expect(noDur.error).toBe('missing_duration')
  })

  it('propone hasta 3 alternativas respetando compromisos y márgenes', () => {
    const task = createTask({ estimated_minutes: 60 })

    // Martes 09:00 a 10:30 ocupado en Bogotá (14:00 a 15:30 UTC)
    const event1 = createEvent({
      starts_at: '2026-10-27T14:00:00Z', // 09:00 Bogotá
      ends_at: '2026-10-27T15:30:00Z',   // 10:30 Bogotá
    })

    const result = generateTaskSuggestions({
      task,
      preferences: basePreferences,
      externalEvents: [event1],
      scheduledTasks: [],
      now,
      today,
    })

    expect(result.proposals).toHaveLength(3)
    // El primer espacio libre del martes en la mañana debe empezar a las 10:45 Bogotá (después del evento de 10:30 + 15 min de buffer)
    // 10:45 Bogotá = 15:45 UTC
    expect(result.proposals[0].start_at).toBe('2026-10-27T15:45:00.000Z')
    expect(result.proposals[0].end_at).toBe('2026-10-27T16:45:00.000Z')
    expect(result.proposals[0].day_date).toBe('2026-10-27')

    // El segundo espacio libre debe ser en la tarde del martes a las 14:00 Bogotá (19:00 UTC)
    expect(result.proposals[1].start_at).toBe('2026-10-27T19:00:00.000Z')

    // El tercer espacio libre más cercano sigue siendo el martes en la tarde a las 15:15 Bogotá (20:15 UTC), respetando el margen de 15 min
    expect(result.proposals[2].start_at).toBe('2026-10-27T20:15:00.000Z')
  })

  it('respeta la fecha límite y no sugiere horarios posteriores al fin de ese día', () => {
    // Vence hoy 2026-10-27
    const taskWithDue = createTask({ estimated_minutes: 60, due_on: '2026-10-27' })

    const result = generateTaskSuggestions({
      task: taskWithDue,
      preferences: basePreferences,
      externalEvents: [],
      scheduledTasks: [],
      now,
      today,
    })

    // Solo debe sugerir horarios del día 27, nunca del 28
    for (const proposal of result.proposals) {
      expect(proposal.day_date).toBe('2026-10-27')
    }
  })

  it('para tareas vencidas indica atraso y ofrece reprogramación tardía', () => {
    // Venció el 2026-10-25
    const overdueTask = createTask({ estimated_minutes: 60, due_on: '2026-10-25' })

    const result = generateTaskSuggestions({
      task: overdueTask,
      preferences: basePreferences,
      externalEvents: [],
      scheduledTasks: [],
      now,
      today,
    })

    expect(result.proposals.length).toBeGreaterThan(0)
    expect(result.proposals[0].is_late_reschedule).toBe(true)
    expect(result.proposals[0].explanation).toContain('Reprogramación tardía')
    expect(result.proposals[0].explanation).toContain('2026-10-25')
    expect(overdueTask.due_on).toBe('2026-10-25')
  })

  it('cambia a reprogramación tardía al terminar el día límite en Bogotá, incluido el cambio de año', () => {
    const dueTask = createTask({ due_on: '2026-12-31' })
    const preferences = { ...basePreferences, slots: [
      { day_of_week: 5, start_time: '09:00', end_time: '18:00' },
    ] }
    const beforeMidnight = generateTaskSuggestions({ task: dueTask, preferences,
      externalEvents: [], scheduledTasks: [], now: new Date('2027-01-01T04:59:00Z') })
    expect(beforeMidnight.proposals).toHaveLength(0) // Aún vence hoy, no puede usar enero.
    const afterMidnight = generateTaskSuggestions({ task: dueTask, preferences,
      externalEvents: [], scheduledTasks: [], now: new Date('2027-01-01T05:00:00Z') })
    expect(afterMidnight.proposals.length).toBeGreaterThan(0)
    expect(afterMidnight.proposals[0].day_date).toBe('2027-01-01')
    expect(afterMidnight.proposals[0].is_late_reschedule).toBe(true)
    expect(afterMidnight.proposals[0].explanation).toContain('2026-12-31')
    expect(dueTask.due_on).toBe('2026-12-31')
  })

  it('respeta la opción de que eventos de todo el día bloqueen la disponibilidad', () => {
    const allDayEvent = createEvent({
      all_day: true,
      start_on: '2026-10-27',
      end_on: '2026-10-28',
    })

    const task = createTask({ estimated_minutes: 60 })

    // Con all_day_blocks = true, el martes 27 queda totalmente bloqueado
    const resultBlocked = generateTaskSuggestions({
      task,
      preferences: { ...basePreferences, all_day_blocks: true },
      externalEvents: [allDayEvent],
      scheduledTasks: [],
      now,
      today,
    })
    // Debe empezar directamente en el miércoles 28
    expect(resultBlocked.proposals[0].day_date).toBe('2026-10-28')

    // Con all_day_blocks = false, el martes 27 sigue disponible
    const resultAllowed = generateTaskSuggestions({
      task,
      preferences: { ...basePreferences, all_day_blocks: false },
      externalEvents: [allDayEvent],
      scheduledTasks: [],
      now,
      today,
    })
    expect(resultAllowed.proposals[0].day_date).toBe('2026-10-27')
  })

  it('maneja tareas programadas sin duración de forma conservadora sin ignorarlas', () => {
    const task = createTask({ estimated_minutes: 60 })
    // Otra tarea ya programada a las 09:00 Bogotá pero sin duración estimada
    const taskWithoutDuration = createTask({
      id: 'no-dur',
      title: 'Otra tarea',
      scheduled_at: '2026-10-27T14:00:00Z', // 09:00 Bogotá
      estimated_minutes: null,
    })

    const result = generateTaskSuggestions({
      task,
      preferences: basePreferences,
      externalEvents: [],
      scheduledTasks: [taskWithoutDuration],
      now,
      today,
    })

    // No debe empezar a las 09:00 Bogotá (14:00 UTC) porque la otra tarea está ahí
    expect(result.proposals[0].start_at).not.toBe('2026-10-27T14:00:00.000Z')
  })
})

describe('detección de conflictos con eventos de calendario', () => {
  it('detecta superposición entre una tarea programada y un evento de calendario', () => {
    const task = createTask({
      scheduled_at: '2026-10-27T15:00:00Z',
      estimated_minutes: 60, // hasta 16:00Z
    })
    const event = createEvent({
      title: 'Reunión médica',
      starts_at: '2026-10-27T15:30:00Z',
      ends_at: '2026-10-27T16:30:00Z',
    })

    const conflict = detectTaskConflict(task, [event])
    expect(conflict).not.toBeNull()
    expect(conflict?.title).toBe('Reunión médica')
  })

  it('no detecta conflicto si los horarios no se solapan', () => {
    const task = createTask({
      scheduled_at: '2026-10-27T15:00:00Z',
      estimated_minutes: 60, // hasta 16:00Z
    })
    const event = createEvent({
      title: 'Cena tarde',
      starts_at: '2026-10-27T18:00:00Z',
      ends_at: '2026-10-27T19:00:00Z',
    })

    const conflict = detectTaskConflict(task, [event])
    expect(conflict).toBeNull()
  })
})

describe('comprobación de cobertura de calendario', () => {
  it('reporta cobertura correcta cuando no hay calendarios seleccionados', () => {
    const coverage = checkCalendarCoverage('2026-10-27', {
      connected: false, hasSelected: false, error: null, syncedAt: null, windowCovered: false,
    }, {
      connected: false, hasSelected: false, error: null, syncedAt: null, windowCovered: false,
    })
    expect(coverage.isCovered).toBe(true)
    expect(coverage.hasSelectedCalendars).toBe(false)
  })

  it('advierte cuando hay error o la ventana no cubre el rango', () => {
    const coverage = checkCalendarCoverage('2026-10-27', {
      connected: true, hasSelected: true, error: 'Fallo de conexión', syncedAt: '2026-10-27T10:00:00Z', windowCovered: false,
    }, {
      connected: false, hasSelected: false, error: null, syncedAt: null, windowCovered: false,
    })
    expect(coverage.isCovered).toBe(false)
    expect(coverage.staleOrError).toBe(true)
    expect(coverage.warning).toContain('Fallo de conexión')
  })
})
