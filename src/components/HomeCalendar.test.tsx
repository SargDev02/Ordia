import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { HomeCalendar } from './HomeCalendar'

vi.mock('../tasks/useBogotaToday', () => ({ useBogotaToday: () => '2026-10-27' }))
vi.mock('../calendar/useCalendarAgenda', () => ({ useCalendarAgenda: () => ({ loading: false, hasWindow: true,
  icloud: { error: '', ready: true, connection: { status: 'connected' }, window: { synced_at: '2026-10-27T14:00:00Z' } },
  google: { error: 'Conexión fallida', ready: true, connection: { status: 'reconnect' }, window: { synced_at: '2026-10-27T14:00:00Z' } },
  calendars: [{ id: 'icloud:c', provider: 'icloud', name: 'Personal' }, { id: 'google:c', provider: 'google', name: 'Trabajo' }],
  events: [
    { id: 'icloud:one', calendar_id: 'icloud:c', title: 'Evento de Apple', all_day: true, start_on: '2026-10-27', end_on: '2026-10-28' },
    { id: 'google:one', calendar_id: 'google:c', title: 'Evento de Google', all_day: false, starts_at: '2026-10-27T15:00:00Z', ends_at: '2026-10-27T16:00:00Z' },
    { id: 'google:tomorrow', calendar_id: 'google:c', title: 'Mañana oculto', all_day: true, start_on: '2026-10-28', end_on: '2026-10-29' },
  ],
}) }))
describe('resumen de hoy unificado (mock)', () => {
  it('muestra los dos proveedores y conserva la copia disponible ante un fallo', () => {
    render(<MemoryRouter><HomeCalendar /></MemoryRouter>)
    expect(screen.getByText('Evento de Apple')).toBeInTheDocument()
    expect(screen.getByText('Evento de Google')).toBeInTheDocument()
    expect(screen.queryByText('Mañana oculto')).not.toBeInTheDocument()
    expect(screen.getByText('iCloud · Personal')).toBeInTheDocument()
    expect(screen.getByText('Google · Trabajo')).toBeInTheDocument()
    expect(screen.getByText(/La copia puede estar desactualizada/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ver calendario' })).toHaveAttribute('href', '/calendario')
  })
})
