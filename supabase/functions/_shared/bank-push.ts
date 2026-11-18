import type { SupabaseClient } from '@supabase/supabase-js'

export interface BankPushTarget { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; bank_notification_id?: string }
export type BankPushSender = (subscription: BankPushTarget, payload: string) => Promise<void>

export async function sendBankPushTargets(admin: SupabaseClient, targets: BankPushTarget[], send: BankPushSender | null, notificationId?: string) {
  const totals = { processed: 0, sent: 0, failed: 0, invalid: 0, skipped: 0 }
  const runId = crypto.randomUUID()
  for (const target of targets) {
    const { data: attemptId, error } = await admin.rpc('claim_bank_push_notification_attempt', {
      p_subscription_id: target.id, p_bank_notification_id: notificationId ?? target.bank_notification_id, p_run_id: runId,
    })
    if (error || !attemptId) continue
    totals.processed++
    const complete = (status: string, http: number | null, code: string | null) => admin.rpc('complete_bank_push_notification_attempt', {
      p_attempt_id: attemptId, p_run_id: runId, p_status: status, p_http_status: http, p_error_code: code,
    })
    const { data: deliverable, error: checkError } = await admin.rpc('is_bank_push_notification_attempt_deliverable', { p_attempt_id: attemptId, p_run_id: runId })
    if (checkError) { await complete('failed', null, 'deliverability_check_failed'); totals.failed++; continue }
    if (!deliverable) { await complete('skipped', null, 'state_changed'); totals.skipped++; continue }
    if (!send) { await complete('failed', null, 'push_configuration_missing'); totals.failed++; continue }
    try {
      await send(target, JSON.stringify({ kind: 'bank_movement_pending', tag: `ordia-bank-${attemptId as string}` }))
      const completed = await complete('sent', null, null)
      if (completed.error) totals.failed++
      else totals.sent++
    } catch (caught) {
      const status = (caught as { statusCode?: number }).statusCode ?? null
      const invalid = status === 404 || status === 410
      const code = status === 404 ? 'subscription_not_found' : status === 410 ? 'subscription_expired'
        : status === 429 ? 'provider_rate_limited' : status && status >= 500 ? 'provider_unavailable' : 'push_delivery_failed'
      await complete(invalid ? 'invalid' : 'failed', status, code)
      if (invalid) totals.invalid++; else totals.failed++
    }
  }
  return totals
}

export async function retryBankPush(admin: SupabaseClient, send: BankPushSender | null, notificationId: string | null = null) {
  const { data, error } = await admin.rpc('list_bank_push_retry_targets', { p_notification_id: notificationId, p_limit: 100 })
  if (error) throw new Error('bank_push_retry_lookup_failed')
  return sendBankPushTargets(admin, (data ?? []) as BankPushTarget[], send)
}
