import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'
import { addDays, getBogotaClock, getReminderKind, isReminderSendWindow } from '../_shared/reminder-policy.ts'

interface PeriodCandidate {
  id: string
  user_id: string
  due_date: string
}

interface SubscriptionCandidate {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

interface PushError {
  statusCode?: number
  body?: string
  message?: string
}

const PAGE_SIZE = 500
const USER_BATCH_SIZE = 100

Deno.serve(async (request) => {
  if (request.method !== 'POST') return Response.json({ error: 'Método no permitido.' }, { status: 405 })

  const configuration = getConfiguration()
  if (!configuration.ok) {
    return Response.json({ error: 'Configuración de servidor incompleta.', missing: configuration.missing }, { status: 503 })
  }
  if (!safeEqual(request.headers.get('x-ordia-cron-secret') ?? '', configuration.cronSecret)) {
    return Response.json({ error: 'No autorizado.' }, { status: 401 })
  }

  const clock = getBogotaClock()
  if (!isReminderSendWindow(clock.hour)) {
    return Response.json({ date: clock.date, status: 'outside_send_window' })
  }

  const secretKeys = JSON.parse(configuration.secretKeys) as Record<string, string>
  const adminKey = secretKeys.default ?? configuration.legacyServiceRoleKey
  if (!adminKey) return Response.json({ error: 'No hay una clave de servidor disponible.' }, { status: 503 })

  const admin = createClient(configuration.supabaseUrl, adminKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  webpush.setVapidDetails(configuration.vapidSubject, configuration.vapidPublicKey, configuration.vapidPrivateKey)

  const tomorrow = addDays(clock.date, 1)
  const periods: PeriodCandidate[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await admin
      .from('fixed_expense_periods')
      .select('id,user_id,due_date')
      .is('transaction_id', null)
      .is('cancelled_at', null)
      .lte('due_date', tomorrow)
      .order('due_date', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) return Response.json({ error: 'No se pudieron consultar las obligaciones.' }, { status: 500 })
    const page = data as PeriodCandidate[]
    periods.push(...page)
    if (page.length < PAGE_SIZE) break
  }

  const candidates = periods.flatMap((period) => {
    const kind = getReminderKind(period.due_date, clock.date)
    return kind ? [{ kind, period }] : []
  })
  const userIds = [...new Set(candidates.map(({ period }) => period.user_id))]
  if (userIds.length === 0) return Response.json({ date: clock.date, processed: 0, sent: 0, invalid: 0, failed: 0 })

  const subscriptions: SubscriptionCandidate[] = []
  for (let batchStart = 0; batchStart < userIds.length; batchStart += USER_BATCH_SIZE) {
    const userBatch = userIds.slice(batchStart, batchStart + USER_BATCH_SIZE)
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await admin
        .from('push_subscriptions')
        .select('id,user_id,endpoint,p256dh,auth')
        .eq('active', true)
        .in('user_id', userBatch)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)
      if (error) return Response.json({ error: 'No se pudieron consultar los dispositivos.' }, { status: 500 })
      const page = data as SubscriptionCandidate[]
      subscriptions.push(...page)
      if (page.length < PAGE_SIZE) break
    }
  }

  const subscriptionsByUser = new Map<string, SubscriptionCandidate[]>()
  for (const subscription of subscriptions) {
    const group = subscriptionsByUser.get(subscription.user_id) ?? []
    group.push(subscription)
    subscriptionsByUser.set(subscription.user_id, group)
  }

  const runId = crypto.randomUUID()
  const totals = { processed: 0, sent: 0, invalid: 0, failed: 0, skipped: 0 }
  for (const { kind, period } of candidates) {
    for (const subscription of subscriptionsByUser.get(period.user_id) ?? []) {
      const { data: attemptId, error: claimError } = await admin.rpc('claim_push_notification_attempt', {
        p_period_id: period.id,
        p_reminder_date: clock.date,
        p_reminder_kind: kind,
        p_run_id: runId,
        p_subscription_id: subscription.id,
      })
      if (claimError || !attemptId) continue
      totals.processed += 1

      const { data: deliverable } = await admin.rpc('is_push_notification_attempt_deliverable', {
        p_attempt_id: attemptId,
        p_run_id: runId,
      })
      if (!deliverable) {
        await complete(admin, attemptId as string, runId, 'skipped', null, 'state_changed')
        totals.skipped += 1
        continue
      }

      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { auth: subscription.auth, p256dh: subscription.p256dh },
        }, JSON.stringify({ kind, tag: `ordia-${attemptId}` }), { TTL: 60 * 60 * 12, urgency: 'normal' })
        await complete(admin, attemptId as string, runId, 'sent')
        totals.sent += 1
      } catch (caught) {
        const error = caught as PushError
        const status = error.statusCode ?? null
        const invalid = status === 404 || status === 410
        await complete(admin, attemptId as string, runId, invalid ? 'invalid' : 'failed', status, sanitizeError(error))
        if (invalid) totals.invalid += 1
        else totals.failed += 1
      }
    }
  }

  return Response.json({ date: clock.date, ...totals })
})

function getConfiguration() {
  const values = {
    cronSecret: Deno.env.get('PUSH_CRON_SECRET') ?? '',
    legacyServiceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    secretKeys: Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}',
    supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
    vapidPrivateKey: Deno.env.get('VAPID_PRIVATE_KEY') ?? '',
    vapidPublicKey: Deno.env.get('VAPID_PUBLIC_KEY') ?? '',
    vapidSubject: Deno.env.get('VAPID_SUBJECT') ?? '',
  }
  const required = ['cronSecret', 'supabaseUrl', 'vapidPrivateKey', 'vapidPublicKey', 'vapidSubject'] as const
  const missing = required.filter((key) => !values[key])
  return missing.length > 0 ? { ok: false as const, missing } : { ok: true as const, ...values }
}

async function complete(admin: ReturnType<typeof createClient>, attemptId: string, runId: string, status: 'sent' | 'failed' | 'invalid' | 'skipped', httpStatus: number | null = null, errorCode: string | null = null) {
  await admin.rpc('complete_push_notification_attempt', {
    p_attempt_id: attemptId,
    p_error_code: errorCode,
    p_http_status: httpStatus,
    p_run_id: runId,
    p_status: status,
  })
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length || left.length === 0) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}

function sanitizeError(error: PushError) {
  if (error.statusCode === 404) return 'subscription_not_found'
  if (error.statusCode === 410) return 'subscription_expired'
  if (error.statusCode === 429) return 'provider_rate_limited'
  if (error.statusCode && error.statusCode >= 500) return 'provider_unavailable'
  return 'push_delivery_failed'
}
