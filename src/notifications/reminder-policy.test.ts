import { describe, expect, it } from 'vitest'
import { addDays, getBogotaClock, getReminderKind, isReminderSendWindow } from '../../supabase/functions/_shared/reminder-policy'

describe('política de recordatorios push', () => {
  it('calcula la fecha de Bogotá alrededor de medianoche UTC', () => {
    expect(getBogotaClock(new Date('2026-10-27T03:30:00Z'))).toEqual({ date: '2026-10-26', hour: 22 })
    expect(getBogotaClock(new Date('2026-10-27T13:00:00Z'))).toEqual({ date: '2026-10-27', hour: 8 })
  })

  it('maneja cambios de mes y año', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('clasifica el día anterior, el vencimiento y cada día vencido', () => {
    expect(getReminderKind('2026-10-27', '2026-10-26')).toBe('day_before')
    expect(getReminderKind('2026-10-26', '2026-10-26')).toBe('due_today')
    expect(getReminderKind('2026-09-30', '2026-10-26')).toBe('overdue')
    expect(getReminderKind('2026-10-28', '2026-10-26')).toBeNull()
  })

  it('limita los envíos al horario de recuperación de Bogotá', () => {
    expect(isReminderSendWindow(7)).toBe(false)
    expect(isReminderSendWindow(8)).toBe(true)
    expect(isReminderSendWindow(20)).toBe(true)
    expect(isReminderSendWindow(21)).toBe(false)
  })
})
