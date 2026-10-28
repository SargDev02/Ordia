import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleTaskWithCheck } from './tasks'
const mocks = vi.hoisted(() => ({ single: vi.fn(), rpc: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { rpc: mocks.rpc } }))
beforeEach(() => { vi.clearAllMocks(); mocks.rpc.mockReturnValue({ single: mocks.single }) })
describe('errores específicos de confirmación de horarios', () => {
  it.each([
    ['22023', 'after_due_date', 'fecha límite'],
    ['22023', 'schedule_in_past', 'pasado'],
    ['22023', 'duration_required', 'duración'],
    ['23P01', 'calendar_event_conflict', 'evento'],
    ['23P01', 'task_schedule_overlap', 'tarea programada'],
    ['22023', 'outside_availability', 'disponibilidad'],
  ])('presenta %s / %s sin confundirlo con otra regla', async (code, message, expected) => {
    mocks.single.mockResolvedValue({ data: null, error: { code, message, details: 'Fixture' } })
    await expect(scheduleTaskWithCheck('task', '2026-11-01T14:00:00Z', 'version', 60, true)).rejects.toThrow(expected)
  })

  it('solo transmite la aceptación explícita de cobertura externa, por defecto desactivada', async () => {
    mocks.single.mockResolvedValue({ data: { id: 'task' }, error: null })
    await scheduleTaskWithCheck('task', '2026-11-01T14:00:00Z', 'version', 60)
    expect(mocks.rpc).toHaveBeenLastCalledWith('schedule_personal_task', expect.objectContaining({
      p_task_id: 'task', p_expected_updated_at: 'version', p_estimated_minutes: 60, p_accept_unverified_calendars: false,
    }))
    await scheduleTaskWithCheck('task', '2026-11-01T14:00:00Z', 'version', 60, true)
    expect(mocks.rpc).toHaveBeenLastCalledWith('schedule_personal_task', expect.objectContaining({ p_accept_unverified_calendars: true }))
  })
})
