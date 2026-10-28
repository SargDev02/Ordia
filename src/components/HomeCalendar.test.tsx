import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeCalendar } from './HomeCalendar'
import type { CalendarEvent } from '../types/calendar'

const createEvent = (input: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e',
  calendar_id: 'icloud:c',
  window_id: 'w',
  user_id: 'u',
  occurrence_key: 'o',
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

let mockToday = '2026-10-27'
let mockCalendarAgenda = {
  loading: false,
  hasWindow: true,
  icloud: { error: '', ready: true, connection: { status: 'connected' }, window: { synced_at: '2026-10-27T14:00:00Z' } },
  google: { error: 'Conexión fallida', ready: true, connection: { status: 'reconnect' }, window: { synced_at: '2026-10-27T14:00:00Z' } },
  calendars: [
    { id: 'icloud:c', provider: 'icloud' as const, name: 'Personal', color: '#4f8068', selected: true, connection_id: 'c', user_id: 'u' },
    { id: 'google:c', provider: 'google' as const, name: 'Trabajo', color: '#315c49', selected: true, connection_id: 'g', user_id: 'u' },
  ],
  events: [] as CalendarEvent[],
}

vi.mock('../tasks/useBogotaToday', () => ({ useBogotaToday: () => mockToday }))
vi.mock('../calendar/useCalendarAgenda', () => ({ useCalendarAgenda: () => mockCalendarAgenda }))

describe('resumen de hoy unificado (mock)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockToday = '2026-10-27'
    mockCalendarAgenda = {
      loading: false,
      hasWindow: true,
      icloud: { error: '', ready: true, connection: { status: 'connected' }, window: { synced_at: '2026-10-27T14:00:00Z' } },
      google: { error: 'Conexión fallida', ready: true, connection: { status: 'reconnect' }, window: { synced_at: '2026-10-27T14:00:00Z' } },
      calendars: [
        { id: 'icloud:c', provider: 'icloud', name: 'Personal', color: '#4f8068', selected: true, connection_id: 'c', user_id: 'u' },
        { id: 'google:c', provider: 'google', name: 'Trabajo', color: '#315c49', selected: true, connection_id: 'g', user_id: 'u' },
      ],
      events: [
        createEvent({ id: 'icloud:one', calendar_id: 'icloud:c', title: 'Evento de Apple', all_day: true, start_on: '2026-10-27', end_on: '2026-10-28' }),
        createEvent({ id: 'google:one', calendar_id: 'google:c', title: 'Evento de Google', all_day: false, starts_at: '2026-10-27T15:00:00Z', ends_at: '2026-10-27T16:00:00Z' }),
        createEvent({ id: 'google:tomorrow', calendar_id: 'google:c', title: 'Mañana oculto', all_day: true, start_on: '2026-10-28', end_on: '2026-10-29' }),
      ],
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('muestra los dos proveedores y conserva la copia disponible ante un fallo', () => {
    // 14:30 UTC: antes de las 15:00 UTC (Evento de Google es próximo)
    vi.setSystemTime(new Date('2026-10-27T14:30:00Z'))
    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)

    expect(screen.getByText('Evento de Apple')).toBeInTheDocument()
    expect(screen.getByText('Evento de Google')).toBeInTheDocument()
    expect(screen.queryByText('Mañana oculto')).not.toBeInTheDocument()
    expect(screen.getByText('iCloud · Personal')).toBeInTheDocument()
    expect(screen.getByText('Google · Trabajo')).toBeInTheDocument()
    expect(screen.getByText(/La copia puede estar desactualizada/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ver calendario' })).toHaveAttribute('href', '/calendario')
  })

  it('muestra únicamente eventos en curso o futuros y oculta eventos terminados (ends_at <= now)', () => {
    // Hora actual: 15:00 Bogotá = 20:00 UTC
    vi.setSystemTime(new Date('2026-10-27T20:00:00Z'))

    mockCalendarAgenda.events = [
      createEvent({ id: 'ended', title: 'Reunión pasada', starts_at: '2026-10-27T18:00:00Z', ends_at: '2026-10-27T19:00:00Z' }),
      createEvent({ id: 'ongoing', title: 'Reunión actual', starts_at: '2026-10-27T19:30:00Z', ends_at: '2026-10-27T20:30:00Z' }),
      createEvent({ id: 'future', title: 'Reunión próxima', starts_at: '2026-10-27T21:00:00Z', ends_at: '2026-10-27T22:00:00Z' }),
    ]

    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)

    // Terminado: oculto
    expect(screen.queryByText('Reunión pasada')).not.toBeInTheDocument()
    // En curso: visible con etiqueta
    expect(screen.getByText('Reunión actual')).toBeInTheDocument()
    expect(screen.getByText('En curso')).toBeInTheDocument()
    // Futuro: visible sin etiqueta "En curso"
    expect(screen.getByText('Reunión próxima')).toBeInTheDocument()
    expect(screen.getAllByText('En curso')).toHaveLength(1)
  })

  it('maneja inicio y fin exactamente iguales a la hora actual', () => {
    vi.setSystemTime(new Date('2026-10-27T20:00:00Z'))

    mockCalendarAgenda.events = [
      // Termina exactamente ahora: fin <= now -> oculto
      createEvent({ id: 'endedExact', title: 'Termina justo ahora', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T20:00:00Z' }),
      // Inicio y fin exactamente ahora: fin <= now -> oculto
      createEvent({ id: 'zeroExact', title: 'Instante actual', starts_at: '2026-10-27T20:00:00Z', ends_at: '2026-10-27T20:00:00Z' }),
      // Inicia exactamente ahora y termina en el futuro -> en curso
      createEvent({ id: 'startsExact', title: 'Empieza justo ahora', starts_at: '2026-10-27T20:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      // Evento puntual sin fin válido que ocurre ahora: fin efectivo = now -> oculto sin inventar duración
      createEvent({ id: 'noEndNow', title: 'Puntual ahora', starts_at: '2026-10-27T20:00:00Z', ends_at: null }),
    ]

    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)

    expect(screen.queryByText('Termina justo ahora')).not.toBeInTheDocument()
    expect(screen.queryByText('Instante actual')).not.toBeInTheDocument()
    expect(screen.queryByText('Puntual ahora')).not.toBeInTheDocument()

    expect(screen.getByText('Empieza justo ahora')).toBeInTheDocument()
    expect(screen.getByText('En curso')).toBeInTheDocument()
  })

  it('conserva todos los eventos simultáneos en curso y mantiene los de todo el día en un grupo diferenciado', () => {
    vi.setSystemTime(new Date('2026-10-27T20:00:00Z'))

    mockCalendarAgenda.events = [
      createEvent({ id: 'ad', title: 'Feriado de hoy', all_day: true, start_on: '2026-10-27', end_on: '2026-10-28' }),
      createEvent({ id: 'sim1', title: 'Simultáneo 1', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      createEvent({ id: 'sim2', title: 'Simultáneo 2', starts_at: '2026-10-27T19:30:00Z', ends_at: '2026-10-27T21:30:00Z' }),
      createEvent({ id: 'future', title: 'Siguiente después', starts_at: '2026-10-27T22:00:00Z', ends_at: '2026-10-27T23:00:00Z' }),
    ]

    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)

    // Grupo diferenciado de todo el día
    expect(screen.getByRole('heading', { name: 'Todo el día', level: 3 })).toBeInTheDocument()
    expect(screen.getByLabelText('Eventos de todo el día')).toBeInTheDocument()
    expect(screen.getByText('Feriado de hoy')).toBeInTheDocument()

    // Eventos simultáneos ambos con "En curso"
    expect(screen.getByText('Simultáneo 1')).toBeInTheDocument()
    expect(screen.getByText('Simultáneo 2')).toBeInTheDocument()
    expect(screen.getAllByText('En curso')).toHaveLength(2)

    // Evento próximo
    expect(screen.getByText('Siguiente después')).toBeInTheDocument()
  })

  it('no oculta eventos en curso si hay más de cinco simultáneos y limita únicamente los próximos', () => {
    vi.setSystemTime(new Date('2026-10-27T20:00:00Z'))

    mockCalendarAgenda.events = [
      createEvent({ id: 'on1', title: 'Guardia 1', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      createEvent({ id: 'on2', title: 'Guardia 2', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      createEvent({ id: 'on3', title: 'Guardia 3', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      createEvent({ id: 'on4', title: 'Guardia 4', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      createEvent({ id: 'on5', title: 'Guardia 5', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      createEvent({ id: 'on6', title: 'Guardia 6', starts_at: '2026-10-27T19:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      createEvent({ id: 'fut1', title: 'Futuro 1', starts_at: '2026-10-27T21:30:00Z', ends_at: '2026-10-27T22:30:00Z' }),
      createEvent({ id: 'fut2', title: 'Futuro 2', starts_at: '2026-10-27T22:30:00Z', ends_at: '2026-10-27T23:30:00Z' }),
    ]

    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)

    // Todos los 6 en curso deben mostrarse
    for (let i = 1; i <= 6; i++) {
      expect(screen.getByText(`Guardia ${i}`)).toBeInTheDocument()
    }
    expect(screen.getAllByText('En curso')).toHaveLength(6)

    // Los futuros están limitados y no se muestran
    expect(screen.queryByText('Futuro 1')).not.toBeInTheDocument()
    expect(screen.queryByText('Futuro 2')).not.toBeInTheDocument()

    // Indicador refleja mostrando 6 de 8
    expect(screen.getByText('Mostrando 6 de 8. Consulta el resto en Calendario.')).toBeInTheDocument()
  })

  it('incluye correctamente eventos que comenzaron el día anterior y continúan hoy', () => {
    // 01:00 Bogotá (06:00 UTC) del 2026-10-27
    vi.setSystemTime(new Date('2026-10-27T06:00:00Z'))

    mockCalendarAgenda.events = [
      createEvent({
        id: 'midnightCrossing',
        title: 'Guardia nocturna',
        // Inició 23:00 Bogotá del 26 (04:00 UTC del 27) y termina 03:00 Bogotá del 27 (08:00 UTC del 27)
        starts_at: '2026-10-27T04:00:00Z',
        ends_at: '2026-10-27T08:00:00Z',
      }),
    ]

    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)

    expect(screen.getByText('Guardia nocturna')).toBeInTheDocument()
    expect(screen.getByText('En curso')).toBeInTheDocument()
  })

  it('actualiza el resumen con el avance del reloj y los siguientes eventos ocupan los lugares liberados', () => {
    // 14:00 Bogotá (19:00 UTC)
    vi.setSystemTime(new Date('2026-10-27T19:00:00Z'))

    // 1 en curso y 5 próximos (total 6 elegibles, límite 5)
    mockCalendarAgenda.events = [
      createEvent({ id: 'cur', title: 'En curso actual', starts_at: '2026-10-27T18:30:00Z', ends_at: '2026-10-27T19:30:00Z' }),
      createEvent({ id: 'p1', title: 'Próximo 1', starts_at: '2026-10-27T20:00:00Z', ends_at: '2026-10-27T21:00:00Z' }),
      createEvent({ id: 'p2', title: 'Próximo 2', starts_at: '2026-10-27T21:00:00Z', ends_at: '2026-10-27T22:00:00Z' }),
      createEvent({ id: 'p3', title: 'Próximo 3', starts_at: '2026-10-27T22:00:00Z', ends_at: '2026-10-27T23:00:00Z' }),
      createEvent({ id: 'p4', title: 'Próximo 4', starts_at: '2026-10-27T23:00:00Z', ends_at: '2026-10-28T00:00:00Z' }),
      createEvent({ id: 'p5', title: 'Próximo 5 (inicialmente fuera del límite)', starts_at: '2026-10-28T01:00:00Z', ends_at: '2026-10-28T02:00:00Z' }),
    ]

    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)

    expect(screen.getByText('En curso actual')).toBeInTheDocument()
    expect(screen.getByText('Próximo 1')).toBeInTheDocument()
    expect(screen.getByText('Próximo 2')).toBeInTheDocument()
    expect(screen.getByText('Próximo 3')).toBeInTheDocument()
    expect(screen.getByText('Próximo 4')).toBeInTheDocument()
    expect(screen.queryByText('Próximo 5 (inicialmente fuera del límite)')).not.toBeInTheDocument()
    expect(screen.getByText('Mostrando 5 de 6. Consulta el resto en Calendario.')).toBeInTheDocument()

    // Avanza el reloj 40 minutos (19:40 UTC, "En curso actual" terminó a las 19:30 UTC)
    act(() => {
      vi.advanceTimersByTime(40 * 60 * 1000)
    })

    // "En curso actual" finalizó y se oculta; "Próximo 5" toma el lugar liberado
    expect(screen.queryByText('En curso actual')).not.toBeInTheDocument()
    expect(screen.getByText('Próximo 5 (inicialmente fuera del límite)')).toBeInTheDocument()
    // Ahora quedan 5 eventos en total, por lo que ya no hay nota de límite
    expect(screen.queryByText(/Mostrando 5 de 6/)).not.toBeInTheDocument()
  })

  it('actualiza el resumen al regresar de segundo plano mediante focus o visibilitychange', () => {
    // 14:00 Bogotá (19:00 UTC)
    vi.setSystemTime(new Date('2026-10-27T19:00:00Z'))

    mockCalendarAgenda.events = [
      createEvent({ id: 'short', title: 'Reunión corta', starts_at: '2026-10-27T18:30:00Z', ends_at: '2026-10-27T19:15:00Z' }),
    ]

    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)
    expect(screen.getByText('Reunión corta')).toBeInTheDocument()

    // El usuario se va de la pestaña; el tiempo pasa a las 19:20 UTC
    vi.setSystemTime(new Date('2026-10-27T19:20:00Z'))

    // Regresa de segundo plano
    act(() => {
      fireEvent(document, new Event('visibilitychange'))
    })

    // Se actualizó inmediatamente sin esperar el temporizador
    expect(screen.queryByText('Reunión corta')).not.toBeInTheDocument()
    expect(screen.getByText('No tienes más eventos programados para hoy')).toBeInTheDocument()
  })

  it('muestra mensaje explícito cuando no quedan eventos para hoy', () => {
    vi.setSystemTime(new Date('2026-10-27T20:00:00Z'))
    // Solo un evento que ya terminó
    mockCalendarAgenda.events = [
      createEvent({ id: 'old', title: 'Pasado', starts_at: '2026-10-27T14:00:00Z', ends_at: '2026-10-27T15:00:00Z' }),
    ]

    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)

    expect(screen.queryByText('Pasado')).not.toBeInTheDocument()
    expect(screen.getByText('No tienes más eventos programados para hoy')).toBeInTheDocument()
  })

  it('conserva mensajes de carga y calendarios sin conectar sin confundirlos con agenda vacía', () => {
    mockCalendarAgenda.loading = true
    const { rerender } = render(<MemoryRouter><HomeCalendar /></MemoryRouter>)
    expect(screen.getByText('Cargando eventos…')).toBeInTheDocument()

    mockCalendarAgenda.loading = false
    mockCalendarAgenda.hasWindow = false
    rerender(<MemoryRouter><HomeCalendar /></MemoryRouter>)
    expect(screen.getByText('Conecta y selecciona calendarios desde Calendario para consultar tus eventos.')).toBeInTheDocument()
  })
})
