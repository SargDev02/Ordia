import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { PushChannel, PushSubscriptionRecord } from '../types/notifications'

const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim() ?? ''

function client() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

function isMissingPushChannelSchemaError(
  error: { code?: string; message?: string; details?: string } | null | undefined,
): boolean {
  if (!error) return false
  if (error.code === '42703' || error.code === '42883' || error.code === 'PGRST202' || error.code === 'PGRST204') {
    return true
  }
  const combined = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase()
  return (
    combined.includes('notify_fixed_expenses') ||
    combined.includes('notify_bank_movements') ||
    combined.includes('register_push_subscription_for_channel') ||
    combined.includes('set_push_channel_preference') ||
    combined.includes('does not exist') ||
    combined.includes('schema cache')
  )
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
  const api = client()
  const fullQuery = await api
    .from('push_subscriptions')
    .select('id,user_id,endpoint,device_label,active,notify_fixed_expenses,notify_bank_movements,disabled_at,disabled_reason,last_seen_at,last_success_at,created_at,updated_at')
    .order('last_seen_at', { ascending: false })

  if (!fullQuery.error) {
    return fullQuery.data as PushSubscriptionRecord[]
  }

  if (isMissingPushChannelSchemaError(fullQuery.error)) {
    const fallbackQuery = await api
      .from('push_subscriptions')
      .select('id,user_id,endpoint,device_label,active,disabled_at,disabled_reason,last_seen_at,last_success_at,created_at,updated_at')
      .order('last_seen_at', { ascending: false })
    if (fallbackQuery.error) throw new Error('No pudimos consultar tus dispositivos.')
    return (fallbackQuery.data as PushSubscriptionRecord[]).map((row) => ({
      ...row,
      notify_fixed_expenses: row.active,
      notify_bank_movements: false,
    }))
  }

  throw new Error('No pudimos consultar tus dispositivos.')
}

export async function activatePushChannel(channel: PushChannel = 'fixed_expenses') {
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

  const api = client()
  const channelResult = await api.rpc('register_push_subscription_for_channel', {
    p_auth: auth,
    p_channel: channel,
    p_device_label: getDeviceLabel(),
    p_endpoint: serialized.endpoint,
    p_p256dh: p256dh,
    p_user_agent: navigator.userAgent,
  })

  if (!channelResult.error && channelResult.data) {
    return channelResult.data as PushSubscriptionRecord
  }

  if (channel === 'fixed_expenses' && isMissingPushChannelSchemaError(channelResult.error)) {
    const legacyResult = await api.rpc('register_push_subscription', {
      p_auth: auth,
      p_device_label: getDeviceLabel(),
      p_endpoint: serialized.endpoint,
      p_p256dh: p256dh,
      p_user_agent: navigator.userAgent,
    })
    if (legacyResult.error) {
      if (!existing) await subscription.unsubscribe()
      throw new Error('No pudimos guardar este dispositivo. Inténtalo de nuevo.')
    }
    return legacyResult.data as PushSubscriptionRecord
  }

  if (!existing) await subscription.unsubscribe()
  if (isMissingPushChannelSchemaError(channelResult.error)) {
    throw new Error('Falta instalar la migración de avisos bancarios automáticos en la base de datos.')
  }
  throw new Error('No pudimos guardar este dispositivo. Inténtalo de nuevo.')
}

export async function activatePushNotifications() {
  return activatePushChannel('fixed_expenses')
}

export async function setPushChannelPreference(
  subscriptionId: string,
  channel: PushChannel,
  enabled: boolean,
): Promise<PushSubscriptionRecord> {
  const api = client()
  const { data, error } = await api.rpc('set_push_channel_preference', {
    p_channel: channel,
    p_enabled: enabled,
    p_subscription_id: subscriptionId,
  })

  if (isMissingPushChannelSchemaError(error)) {
    if (channel === 'fixed_expenses' && !enabled) {
      await deactivatePushNotifications(subscriptionId)
      return {
        id: subscriptionId,
        user_id: '',
        endpoint: '',
        device_label: getDeviceLabel(),
        active: false,
        notify_fixed_expenses: false,
        notify_bank_movements: false,
        disabled_at: new Date().toISOString(),
        disabled_reason: 'user',
        last_seen_at: new Date().toISOString(),
        last_success_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    }
    throw new Error('Falta instalar la migración de preferencias independientes de notificaciones en la base de datos.')
  }

  if (error || !data) {
    throw new Error('No pudimos actualizar tu preferencia de notificaciones en este dispositivo.')
  }

  const updated = data as PushSubscriptionRecord
  if (!updated.active) {
    const browserSubscription = await getCurrentBrowserSubscription()
    await browserSubscription?.unsubscribe()
  }
  return updated
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
