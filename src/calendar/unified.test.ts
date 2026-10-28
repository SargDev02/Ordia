import { describe, expect, it } from 'vitest'
import { unifyCalendars } from './unified'
import type { CalendarSnapshot } from '../types/calendar'
function snapshot(selected = true): CalendarSnapshot {
  return { connection: { id: 'same-connection', user_id: 'a', generation: 'g', status: 'connected', error_code: null, updated_at: '' },
    calendars: [{ id: 'same-calendar', connection_id: 'same-connection', user_id: 'a', name: 'Principal', color: '#123456', selected }], window: null,
    events: [{ id: 'same-event', window_id: 'w', user_id: 'a', calendar_id: 'same-calendar', occurrence_key: 'same-instance', title: 'Igual', description: '', location: '', url: null, all_day: true, starts_at: null, ends_at: null, start_on: '2026-10-27', end_on: '2026-10-28' }] }
}
describe('agenda combinada', () => {
  it('separa proveedor, conexión, calendario e instancia aunque coincidan título, hora e identificadores', () => {
    const result = unifyCalendars([{ provider: 'icloud', snapshot: snapshot() }, { provider: 'google', snapshot: snapshot() }])
    expect(result.events).toHaveLength(2)
    expect(new Set(result.events.map((event) => event.id)).size).toBe(2)
    expect(new Set(result.calendars.map((calendar) => calendar.id)).size).toBe(2)
  })
  it('respeta selección de uno, ambos o ninguno sin mezclar identidades', () => {
    expect(unifyCalendars([{ provider: 'icloud', snapshot: snapshot(true) }, { provider: 'google', snapshot: snapshot(false) }]).events).toHaveLength(1)
    expect(unifyCalendars([{ provider: 'icloud', snapshot: snapshot(false) }, { provider: 'google', snapshot: snapshot(false) }]).events).toHaveLength(0)
    const disconnected = snapshot(); disconnected.connection!.status = 'disconnected'
    expect(unifyCalendars([{ provider: 'icloud', snapshot: snapshot() }, { provider: 'google', snapshot: disconnected }]).events).toHaveLength(1)
  })
})
