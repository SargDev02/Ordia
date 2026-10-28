import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useBogotaToday } from './useBogotaToday'

afterEach(() => { vi.useRealTimers() })
describe('fecha visible de las tareas', () => {
  it('cambia de día sin recargar en el límite de año de Bogotá', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-01T04:59:59Z'))
    const { result } = renderHook(useBogotaToday)
    expect(result.current).toBe('2026-12-31')
    act(() => { vi.advanceTimersByTime(1100) })
    expect(result.current).toBe('2027-01-01')
  })
  it('recupera el día al volver a una pestaña suspendida', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-31T20:00:00Z'))
    const { result } = renderHook(useBogotaToday)
    act(() => { vi.setSystemTime(new Date('2026-11-02T12:00:00Z')); window.dispatchEvent(new Event('focus')) })
    expect(result.current).toBe('2026-11-02')
  })
})
