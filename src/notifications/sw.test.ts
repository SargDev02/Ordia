import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function loadServiceWorkerHarness() {
  const swPath = resolve(process.cwd(), 'public/sw.js')
  const swSource = readFileSync(swPath, 'utf8')

  const listeners = new Map<string, (event: Record<string, unknown>) => void>()
  const showNotification = vi.fn().mockResolvedValue(undefined)
  const matchAll = vi.fn().mockResolvedValue([])
  const openWindow = vi.fn().mockResolvedValue(undefined)

  const selfMock = {
    location: { origin: 'https://ordia.test' },
    addEventListener: (type: string, handler: (event: Record<string, unknown>) => void) => {
      listeners.set(type, handler)
    },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      matchAll,
      openWindow,
    },
    registration: {
      showNotification,
    },
  }

  const context = vm.createContext({
    self: selfMock,
    URL,
    caches: {
      open: vi.fn().mockResolvedValue({ addAll: vi.fn() }),
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
      match: vi.fn(),
    },
    fetch: vi.fn(),
  })

  vm.runInContext(swSource, context)

  return { listeners, showNotification, matchAll, openWindow }
}

describe('service worker de notificaciones Web Push (public/sw.js)', () => {
  it('muestra «Ordia · Movimiento por revisar» sin datos sensibles y abre la bandeja bancaria al tocar', async () => {
    const { listeners, showNotification, matchAll, openWindow } = loadServiceWorkerHarness()

    const pushPromises: Promise<unknown>[] = []
    listeners.get('push')?.({
      data: {
        json: () => ({
          kind: 'bank_movement_pending',
          tag: 'ordia-bank-123',
        }),
      },
      waitUntil: (promise: Promise<unknown>) => pushPromises.push(promise),
    })
    await Promise.all(pushPromises)

    expect(showNotification).toHaveBeenCalledWith('Ordia · Movimiento por revisar', {
      body: 'Tienes un aviso bancario nuevo listo para revisar.',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: 'ordia-bank-123',
      data: { path: '/?bandeja=bancaria#movimientos-por-revisar' },
    })

    // Al tocar sin pestaña abierta -> openWindow a la bandeja bancaria
    const clickPromises1: Promise<unknown>[] = []
    const close1 = vi.fn()
    listeners.get('notificationclick')?.({
      notification: {
        close: close1,
        data: { path: '/?bandeja=bancaria#movimientos-por-revisar' },
      },
      waitUntil: (promise: Promise<unknown>) => clickPromises1.push(promise),
    })
    await Promise.all(clickPromises1)
    expect(close1).toHaveBeenCalledOnce()
    expect(openWindow).toHaveBeenCalledWith('/?bandeja=bancaria#movimientos-por-revisar')

    // Al tocar con pestaña existente del mismo origen -> navigate y focus
    const navigate = vi.fn().mockResolvedValue(undefined)
    const focus = vi.fn().mockResolvedValue(undefined)
    matchAll.mockResolvedValueOnce([{ url: 'https://ordia.test/tareas', navigate, focus }])

    const clickPromises2: Promise<unknown>[] = []
    listeners.get('notificationclick')?.({
      notification: {
        close: vi.fn(),
        data: { path: '/?bandeja=bancaria#movimientos-por-revisar' },
      },
      waitUntil: (promise: Promise<unknown>) => clickPromises2.push(promise),
    })
    await Promise.all(clickPromises2)
    expect(navigate).toHaveBeenCalledWith('/?bandeja=bancaria#movimientos-por-revisar')
    expect(focus).toHaveBeenCalledOnce()
  })

  it('conserva intactos los recordatorios de gastos fijos y bloquea rutas externas malformadas', async () => {
    const { listeners, showNotification, openWindow } = loadServiceWorkerHarness()

    const pushPromises: Promise<unknown>[] = []
    listeners.get('push')?.({
      data: {
        json: () => ({ kind: 'due_today', tag: 'ordia-fixed-1' }),
      },
      waitUntil: (promise: Promise<unknown>) => pushPromises.push(promise),
    })
    await Promise.all(pushPromises)

    expect(showNotification).toHaveBeenCalledWith('Ordia', {
      body: 'Tienes un pago pendiente para hoy.',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: 'ordia-fixed-1',
      data: { path: '/gastos-fijos' },
    })

    const clickPromises: Promise<unknown>[] = []
    listeners.get('notificationclick')?.({
      notification: {
        close: vi.fn(),
        data: { path: '//sitio-externo.invalid/phishing' },
      },
      waitUntil: (promise: Promise<unknown>) => clickPromises.push(promise),
    })
    await Promise.all(clickPromises)
    expect(openWindow).toHaveBeenCalledWith('/gastos-fijos')
  })
})
