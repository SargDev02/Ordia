import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { PushSubscriptionRecord } from '../types/notifications'

const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim() ?? ''

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

export function isPushConfigured() {
  return vapidPublicKey.length > 0
}

export function isPushSupported() {
  return window.isSecureContext
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

export function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
}

export async function getCurrentBrowserSubscription() {
  if (!isPushSupported()) return null
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

export async function listPushSubscriptions() {
  const { data, error } = await client()
    .from('push_subscriptions')
    .select('id,user_id,endpoint,device_label,active,disabled_at,disabled_reason,last_seen_at,last_success_at,created_at,updated_at')
    .order('last_seen_at', { ascending: false })
  if (error) throw new Error('No pudimos consultar tus dispositivos.')
  return data as PushSubscriptionRecord[]
}

export async function activatePushNotifications() {
  if (!isPushConfigured()) throw new Error('Falta configurar la clave pública VAPID.')
  if (!isPushSupported()) throw new Error('Este dispositivo no ofrece Web Push en este entorno.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'El permiso fue denegado. Puedes cambiarlo desde la configuración del navegador o del dispositivo.'
      : 'No se concedió el permiso para mostrar notificaciones.')
  }

  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  const subscription = existing ?? await registration.pushManager.subscribe({
    applicationServerKey: base64UrlToUint8Array(vapidPublicKey),
    userVisibleOnly: true,
  })
  const serialized = subscription.toJSON()
  const p256dh = serialized.keys?.p256dh
  const auth = serialized.keys?.auth
  if (!serialized.endpoint || !p256dh || !auth) {
    if (!existing) await subscription.unsubscribe()
    throw new Error('El navegador no entregó una suscripción push completa.')
  }

  const { data, error } = await client().rpc('register_push_subscription', {
    p_auth: auth,
    p_device_label: getDeviceLabel(),
    p_endpoint: serialized.endpoint,
    p_p256dh: p256dh,
    p_user_agent: navigator.userAgent,
  })
  if (error) {
    if (!existing) await subscription.unsubscribe()
    throw new Error('No pudimos guardar este dispositivo. Inténtalo de nuevo.')
  }
  return data as PushSubscriptionRecord
}

export async function deactivatePushNotifications(subscriptionId: string) {
  const browserSubscription = await getCurrentBrowserSubscription()
  let serverError = false
  try {
    const { error } = await client().rpc('disable_push_subscription', { p_subscription_id: subscriptionId })
    serverError = Boolean(error)
  } finally {
    await browserSubscription?.unsubscribe()
  }
  if (serverError) throw new Error('El navegador quedó desactivado, pero no pudimos actualizar la lista de dispositivos todavía.')
}

export async function deactivatePushOnCurrentDevice(activeClient: SupabaseClient | null = supabase) {
  if (!isPushSupported()) return
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = await registration?.pushManager.getSubscription()
  if (!subscription) return
  try {
    if (activeClient) {
      await activeClient.rpc('disable_current_push_subscription', { p_endpoint: subscription.endpoint })
    }
  } finally {
    await subscription.unsubscribe()
  }
}

export function base64UrlToUint8Array(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from(raw, (character) => character.charCodeAt(0))
}

function getDeviceLabel() {
  if (isIosDevice()) return 'iPhone o iPad'
  if (/Android/.test(navigator.userAgent)) return 'Dispositivo Android'
  return 'Navegador de computador'
}
