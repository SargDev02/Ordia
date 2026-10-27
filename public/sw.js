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
  const body = payload.kind === 'day_before'
    ? 'Tienes un pago pendiente para mañana.'
    : payload.kind === 'due_today'
      ? 'Tienes un pago pendiente para hoy.'
      : 'Tienes un pago vencido por revisar.'

  event.waitUntil(self.registration.showNotification('Ordia', {
    body,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    data: { path: '/gastos-fijos' },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin)
      if (existing) {
        await existing.navigate('/gastos-fijos')
        return existing.focus()
      }
      return self.clients.openWindow('/gastos-fijos')
    }),
  )
})
