import { describe, expect, it } from 'vitest'
import {
  calendarWeekStart,
  eventsOnDay,
  eventTimeLabel,
  getEventEffectiveRange,
  getSummaryEventStatus,
  getTodaySummaryEvents,
  isEventOnBogotaDay,
} from './dates'
import type { CalendarEvent } from '../types/calendar'

const event = (input: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'a',
  user_id: 'a',
  window_id: 'w',
  calendar_id: 'c',
  occurrence_key: 'a',
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

describe('regla explícita para eventos sin fin válido', () => {
  it('para eventos con horario sin fin válido o fin anterior a inicio, define endMs = startMs', () => {
    const startStr = '2026-10-27T15:00:00Z'
    const startMs = Date.parse(startStr)

    // Sin ends_at
    const noEnd = event({ starts_at: startStr, ends_at: null })
    const r1 = getEventEffectiveRange(noEnd)
    expect(r1.isValid).toBe(true)
    expect(r1.startMs).toBe(startMs)
    expect(r1.endMs).toBe(startMs)

    // Con ends_at no parseable
    const invalidEnd = event({ starts_at: startStr, ends_at: 'invalido' })
    const r2 = getEventEffectiveRange(invalidEnd)
    expect(r2.isValid).toBe(true)
    expect(r2.endMs).toBe(startMs)

    // Con ends_at anterior a starts_at
    const earlierEnd = event({ starts_at: startStr, ends_at: '2026-10-27T14:00:00Z' })
    const r3 = getEventEffectiveRange(earlierEnd)
    expect(r3.isValid).toBe(true)
    expect(r3.endMs).toBe(startMs)

    // Etiqueta de tiempo para evento puntual
    expect(eventTimeLabel(noEnd)).not.toContain('—')
    expect(eventTimeLabel(noEnd)).toContain('10:00 a. m.')
  })

  it('para eventos de todo el día sin fin válido, define end_on como start_on + 1 día', () => {
    const noEndOn = event({ all_day: true, start_on: '2026-10-27', end_on: null })
    const r1 = getEventEffectiveRange(noEndOn)
    expect(r1.isValid).toBe(true)
    expect(r1.endOn).toBe('2026-10-28')

    const invalidEndOn = event({ all_day: true, start_on: '2026-10-27', end_on: '2026-10-20' })
    const r2 = getEventEffectiveRange(invalidEndOn)
    expect(r2.isValid).toBe(true)
    expect(r2.endOn).toBe('2026-10-28')

    expect(eventTimeLabel(noEndOn)).toBe('Todo el día')
  })
})

describe('cálculo de pertenencia al día de Bogotá y estado en el resumen', () => {
  const today = '2026-10-27'
  const now = new Date('2026-10-27T15:00:00-05:00') // 20:00:00 UTC

  it('identifica evento terminado, en curso y futuro', () => {
    const ended = event({
      id: 'ended',
      starts_at: '2026-10-27T18:00:00Z', // 13:00 Bogotá
      ends_at: '2026-10-27T19:00:00Z',   // 14:00 Bogotá (< 15:00)
    })
    const ongoing = event({
      id: 'ongoing',
      starts_at: '2026-10-27T19:30:00Z', // 14:30 Bogotá
      ends_at: '2026-10-27T20:30:00Z',   // 15:30 Bogotá (> 15:00)
    })
    const upcoming = event({
      id: 'upcoming',
      starts_at: '2026-10-27T21:00:00Z', // 16:00 Bogotá
      ends_at: '2026-10-27T22:00:00Z',   // 17:00 Bogotá
    })

    expect(getSummaryEventStatus(ended, now, today)).toBe('ended')
    expect(getSummaryEventStatus(ongoing, now, today)).toBe('ongoing')
    expect(getSummaryEventStatus(upcoming, now, today)).toBe('upcoming')
  })

  it('maneja inicio y fin exactamente iguales a la hora actual', () => {
    // Exactamente ahora: inicio 15:00 Bogotá, fin 15:00 Bogotá
    const exactNow = event({
      id: 'exactNow',
      starts_at: '2026-10-27T20:00:00Z',
      ends_at: '2026-10-27T20:00:00Z',
    })
    // Fin <= now -> terminó, debe ocultarse
    expect(getSummaryEventStatus(exactNow, now, today)).toBe('ended')

    // Inicio exactamente ahora, termina en el futuro -> en curso
    const startsNow = event({
      id: 'startsNow',
      starts_at: '2026-10-27T20:00:00Z',
      ends_at: '2026-10-27T21:00:00Z',
    })
    expect(getSummaryEventStatus(startsNow, now, today)).toBe('ongoing')

    // Inició antes y termina exactamente ahora -> fin <= now -> terminó, oculto
    const endsNow = event({
      id: 'endsNow',
      starts_at: '2026-10-27T19:00:00Z',
      ends_at: '2026-10-27T20:00:00Z',
    })
    expect(getSummaryEventStatus(endsNow, now, today)).toBe('ended')

    // Evento puntual sin fin válido que ocurre ahora: fin = inicio = now -> terminó
    const punctualNow = event({
      id: 'punctualNow',
      starts_at: '2026-10-27T20:00:00Z',
      ends_at: null,
    })
    expect(getSummaryEventStatus(punctualNow, now, today)).toBe('ended')

    // Evento puntual futuro sin fin válido: es próximo
    const punctualFuture = event({
      id: 'punctualFuture',
      starts_at: '2026-10-27T21:00:00Z',
      ends_at: null,
    })
    expect(getSummaryEventStatus(punctualFuture, now, today)).toBe('upcoming')
  })

  it('maneja eventos que cruzan medianoche', () => {
    // Inició ayer a las 23:00 Bogotá (2026-10-27T04:00:00Z) y termina hoy a las 02:00 Bogotá (2026-10-27T07:00:00Z)
    const overnight = event({
      id: 'overnight',
      starts_at: '2026-10-27T04:00:00Z',
      ends_at: '2026-10-27T07:00:00Z',
    })
    expect(isEventOnBogotaDay(overnight, '2026-10-27')).toBe(true)

    // A la 01:00 Bogotá (06:00 UTC) está en curso hoy
    const at01 = new Date('2026-10-27T06:00:00Z')
    expect(getSummaryEventStatus(overnight, at01, '2026-10-27')).toBe('ongoing')

    // A las 02:00 Bogotá (07:00 UTC) ya terminó
    const at02 = new Date('2026-10-27T07:00:00Z')
    expect(getSummaryEventStatus(overnight, at02, '2026-10-27')).toBe('ended')
  })

  it('maneja eventos de todo el día respetando la fecha final exclusiva', () => {
    const allDay = event({
      id: 'allDay',
      all_day: true,
      start_on: '2026-10-26',
      end_on: '2026-10-28', // Activo 26 y 27; termina el 28 (exclusivo)
    })
    expect(isEventOnBogotaDay(allDay, '2026-10-27')).toBe(true)
    expect(getSummaryEventStatus(allDay, now, '2026-10-27')).toBe('all_day')

    // El 28 ya no debe aparecer
    expect(isEventOnBogotaDay(allDay, '2026-10-28')).toBe(false)
    expect(getSummaryEventStatus(allDay, new Date('2026-10-28T10:00:00Z'), '2026-10-28')).toBeNull()
  })

  it('ordena en curso primero, conserva simultáneos y aplica el límite después', () => {
    const ongoing1 = event({ id: 'o1', title: 'En curso 1', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T21:00:00Z' })
    const ongoing2 = event({ id: 'o2', title: 'En curso 2 (simultáneo)', starts_at: '2026-10-27T19:30:00Z', ends_at: '2026-10-27T21:30:00Z' })
    const allDay = event({ id: 'ad', title: 'Todo el día', all_day: true, start_on: '2026-10-27', end_on: '2026-10-28' })
    const up1 = event({ id: 'u1', title: 'Próximo 1', starts_at: '2026-10-27T21:00:00Z', ends_at: '2026-10-27T22:00:00Z' })
    const up2 = event({ id: 'u2', title: 'Próximo 2', starts_at: '2026-10-27T22:00:00Z', ends_at: '2026-10-27T23:00:00Z' })
    const up3 = event({ id: 'u3', title: 'Próximo 3 (quedará fuera con límite 4)', starts_at: '2026-10-27T23:00:00Z', ends_at: '2026-10-28T00:00:00Z' })
    const finished = event({ id: 'fin', title: 'Terminado', starts_at: '2026-10-27T17:00:00Z', ends_at: '2026-10-27T18:00:00Z' })

    const events = [up3, finished, ongoing2, allDay, up1, ongoing1, up2]
    const summary = getTodaySummaryEvents(events, now, today, 4)

    expect(summary.totalEligibleCount).toBe(6) // o1, o2, ad, u1, u2, u3 (finished está excluido)
    expect(summary.allVisible).toHaveLength(4)
    expect(summary.ongoing).toHaveLength(2)
    expect(summary.ongoing.map((e) => e.id)).toEqual(['o1', 'o2']) // Simultáneos conservados
    expect(summary.allDay.map((e) => e.id)).toEqual(['ad'])
    expect(summary.upcoming.map((e) => e.id)).toEqual(['u1'])

    // Al avanzar el tiempo a las 21:05: o1 terminó (21:00), u1 comenzó (21:00) y ahora está en curso junto a o2
    const later = new Date('2026-10-27T21:05:00Z')
    const summaryLater = getTodaySummaryEvents(events, later, today, 4)
    expect(summaryLater.ongoing.map((e) => e.id)).toEqual(['o2', 'u1']) // o2 y u1 están en curso
    expect(summaryLater.allDay.map((e) => e.id)).toEqual(['ad'])
    // El siguiente evento próximo que estaba fuera (u2) ahora ocupa el 4to lugar liberado:
    expect(summaryLater.upcoming.map((e) => e.id)).toEqual(['u2'])
    expect(summaryLater.allVisible.map((e) => e.id)).toEqual(['o2', 'u1', 'ad', 'u2'])
  })

  it('no oculta eventos en curso si hay más de cinco simultáneos y limita únicamente los próximos', () => {
    // 6 eventos en curso simultáneos y 2 próximos con límite predeterminado de 5
    const ongoingList = Array.from({ length: 6 }, (_, i) =>
      event({
        id: `on_${i + 1}`,
        title: `En curso ${i + 1}`,
        starts_at: '2026-10-27T19:00:00Z',
        ends_at: '2026-10-27T21:00:00Z',
      })
    )
    const upcoming1 = event({ id: 'up1', title: 'Próximo 1', starts_at: '2026-10-27T21:30:00Z', ends_at: '2026-10-27T22:30:00Z' })
    const upcoming2 = event({ id: 'up2', title: 'Próximo 2', starts_at: '2026-10-27T22:30:00Z', ends_at: '2026-10-27T23:30:00Z' })

    const summary = getTodaySummaryEvents([...ongoingList, upcoming1, upcoming2], now, today, 5)

    expect(summary.totalEligibleCount).toBe(8)
    // Se conservan todos los 6 en curso
    expect(summary.ongoing).toHaveLength(6)
    expect(summary.allVisible).toHaveLength(6)
    expect(summary.allVisible.map((e) => e.id)).toEqual(['on_1', 'on_2', 'on_3', 'on_4', 'on_5', 'on_6'])
    // Los próximos se limitan a 0 porque los en curso ya coparon el cupo de 5
    expect(summary.upcoming).toHaveLength(0)
  })
})
