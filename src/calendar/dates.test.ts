import { describe, expect, it } from 'vitest'
import { calendarWeekStart, eventsOnDay, eventTimeLabel } from './dates'
import type { CalendarEvent } from '../types/calendar'
const event = (input: Partial<CalendarEvent>): CalendarEvent => ({ id: 'a', user_id: 'a', window_id: 'w', calendar_id: 'c', occurrence_key: 'a', title: 'Evento', description: '', location: '', url: null, all_day: false, starts_at: null, ends_at: null, start_on: null, end_on: null, ...input })
describe('agenda por día de Bogotá', () => {
  it('respeta fines exclusivos de todo el día y cambio de mes/año', () => {
    const allDay = event({ all_day: true, start_on: '2026-12-31', end_on: '2027-01-02' })
    expect(eventsOnDay([allDay], '2026-12-31')).toHaveLength(1)
    expect(eventsOnDay([allDay], '2027-01-01')).toHaveLength(1)
    expect(eventsOnDay([allDay], '2027-01-02')).toHaveLength(0)
    expect(eventTimeLabel(allDay)).toContain('2027-01-01')
    expect(calendarWeekStart('2027-01-01')).toBe('2026-12-28')
  })
  it('asigna el instante a su día local e incluye eventos que cruzan medianoche', () => {
    const crossing = event({ starts_at: '2026-10-28T04:30:00Z', ends_at: '2026-10-28T05:30:00Z' })
    expect(eventsOnDay([crossing], '2026-10-27')).toHaveLength(1)
    expect(eventsOnDay([crossing], '2026-10-28')).toHaveLength(1)
    expect(eventsOnDay([event({ starts_at: '2026-10-28T05:00:00Z', ends_at: '2026-10-28T06:00:00Z' })], '2026-10-27')).toHaveLength(0)
  })
})
