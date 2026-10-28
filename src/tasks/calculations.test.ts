import { describe, expect, it } from 'vitest'
import { getBogotaToday } from '../finance/calculations'
import { filterTasks, fromBogotaDateTimeInput, isTaskOverdue, selectHomeTasks, toBogotaDateTimeInput } from './calculations'
import type { PersonalTask } from '../types/tasks'

export function taskFixture(id: string, overrides: Partial<PersonalTask> = {}): PersonalTask {
  return { id, user_id: 'user-a', client_request_id: id, title: id, description: null, priority: 'medium', estimated_minutes: null,
    due_on: null, scheduled_at: null, is_completed: false, completed_at: null, deleted_at: null, created_at: '', updated_at: '', ...overrides }
}

describe('organización de tareas en Bogotá', () => {
  it('no vence por programación pasada ni vence hoy antes de terminar el día', () => {
    const items = [taskFixture('sin-fechas'), taskFixture('programada', { scheduled_at: '2026-01-01T10:00:00Z' }),
      taskFixture('hoy', { due_on: '2026-10-27' }), taskFixture('ayer', { due_on: '2026-10-26' })]
    expect(filterTasks(items, 'overdue', '2026-10-27').map((task) => task.id)).toEqual(['ayer'])
    expect(filterTasks(items, 'pending', '2026-10-27')).toHaveLength(4)
    expect(filterTasks(items, 'scheduled', '2026-10-27').map((task) => task.id)).toEqual(['programada'])
  })

  it('reúne hoy, límite hoy y vencidas sin repetir una tarea y excluye realizadas y eliminadas', () => {
    const items = [taskFixture('ambas', { scheduled_at: '2026-10-28T04:59:00Z', due_on: '2026-10-27' }),
      taskFixture('limite', { due_on: '2026-10-27' }), taskFixture('deuda', { due_on: '2026-10-01' }),
      taskFixture('futura', { scheduled_at: '2026-10-28T05:00:00Z' }), taskFixture('libre'),
      taskFixture('hecha', { due_on: '2026-10-01', is_completed: true, completed_at: '2026-10-27T15:00:00Z' }),
      taskFixture('eliminada', { due_on: '2026-10-01', deleted_at: '2026-10-27T15:00:00Z' })]
    expect(selectHomeTasks(items, '2026-10-27').map((task) => task.id).sort()).toEqual(['ambas', 'deuda', 'limite'])
    expect(filterTasks(items, 'completed', '2026-10-27').map((task) => task.id)).toEqual(['hecha'])
  })

  it.each([
    ['2026-11-01T04:59:59Z', '2026-10-31', false], ['2026-11-01T05:00:00Z', '2026-11-01', true],
    ['2027-01-01T04:59:59Z', '2026-12-31', false], ['2027-01-01T05:00:00Z', '2027-01-01', true],
  ])('respeta el límite de día, mes y año %s', (instant, today, overdue) => {
    expect(getBogotaToday(new Date(instant))).toBe(today)
    const due = instant.startsWith('2026-11') ? '2026-10-31' : '2026-12-31'
    expect(isTaskOverdue(taskFixture('limite', { due_on: due }), today)).toBe(overdue)
  })

  it('filtra título y prioridad y conserva fechas sin convertirlas a UTC', () => {
    const items = [taskFixture('a', { title: 'Comprar pan', priority: 'high', due_on: '2026-10-27' }), taskFixture('b', { title: 'Comprar café' })]
    expect(filterTasks(items, 'pending', '2026-10-27', ' COMPRAR ', 'high').map((task) => task.id)).toEqual(['a'])
    expect(fromBogotaDateTimeInput('2026-12-31T23:30')).toBe('2027-01-01T04:30:00.000Z')
    expect(toBogotaDateTimeInput('2027-01-01T04:30:00Z')).toBe('2026-12-31T23:30')
    expect(() => fromBogotaDateTimeInput('2026-02-30T10:00')).toThrow()
  })
})
