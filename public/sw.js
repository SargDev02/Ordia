const CACHE_NAME = 'ordia-shell-v1'
const APP_SHELL = ['/', '/manifest.webmanifest', '/favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate') return
  event.respondWith(fetch(event.request).catch(() => caches.match('/')))
})

self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data?.json() ?? {} } catch { payload = {} }
  const isBankMovement = payload.kind === 'bank_movement_pending'
  const title = isBankMovement ? 'Ordia · Movimiento por revisar' : 'Ordia'
  const body = isBankMovement
    ? 'Tienes un aviso bancario nuevo listo para revisar.'
    : payload.kind === 'day_before'
      ? 'Tienes un pago pendiente para mañana.'
      : payload.kind === 'due_today'
        ? 'Tienes un pago pendiente para hoy.'
        : 'Tienes un pago vencido por revisar.'
  const path = isBankMovement ? '/?bandeja=bancaria#movimientos-por-revisar' : '/gastos-fijos'

  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    data: { path },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const rawPath = event.notification.data?.path
  const targetPath = typeof rawPath === 'string' && rawPath.startsWith('/') && !rawPath.startsWith('//')
    ? rawPath
    : '/gastos-fijos'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin)
      if (existing) {
        await existing.navigate(targetPath)
        return existing.focus()
      }
      return self.clients.openWindow(targetPath)
    }),
  )
})
