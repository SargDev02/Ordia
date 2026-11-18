import { retryBankPush, sendBankPushTargets } from '../bank-push.ts'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  classifyInboundEmail,
  extractVerifiedAliasLocalPart,
  sha256Hex,
  verifySvixSignature,
  type ReceivedEmailPayload,
} from './mime-and-auth.ts'

export interface BankEmailWebhookConfig {
  webhookSecret: string
  resendApiKey: string
  inboundDomain: string
  pushConfigured: boolean
}

export interface PushTargetSubscription {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
}

export interface WebPushSenderError {
  statusCode?: number
  message?: string
}

export type SendBankPushFn = (
  subscription: PushTargetSubscription,
  payload: string,
) => Promise<void>

interface ResendWebhookEnvelope {
  type?: string
  data?: {
    email_id?: string
    from?: string | null
    to?: string[] | string | null
    received_for?: string[] | string | null
    subject?: string | null
  }
}

interface IngestNotificationRpcResult {
  outcome: 'created' | 'duplicate' | 'alias_not_found' | 'alias_inactive'
  is_new_notification: boolean
  user_id?: string
  notification_id?: string | null
}

interface RecordConfirmationRpcResult {
  outcome: 'recorded' | 'duplicate' | 'already_confirmed' | 'alias_not_found' | 'alias_inactive'
  updated: boolean
}

const MAX_WEBHOOK_BYTES = 524_288

function extractMessageIdHeader(email: ReceivedEmailPayload): string | null {
  if (typeof email.message_id === 'string' && email.message_id.trim()) {
    return email.message_id.trim()
  }
  if (!email.headers) return null
  for (const [key, value] of Object.entries(email.headers)) {
    if (key.toLowerCase() !== 'message-id') continue
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim())
      if (first) return first.trim()
    }
  }
  return null
}

export function createBankEmailWebhookHandler(
  config: BankEmailWebhookConfig,
  admin: SupabaseClient,
  sendPush: SendBankPushFn | null,
  fetcher: typeof fetch = fetch,
  nowProvider: () => number = () => Math.floor(Date.now() / 1000),
) {
  return async function handleRequest(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Método no permitido.' }, { status: 405 })
    }

    if (!config.webhookSecret.trim() || !config.resendApiKey.trim() || !config.inboundDomain.trim()) {
      return Response.json(
        { error: 'Configuración de recepción de correo incompleta en el servidor.' },
        { status: 503 },
      )
    }

    const contentLength = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
      return Response.json({ error: 'Carga útil demasiado grande.' }, { status: 413 })
    }

    const rawBody = await request.text()
    if (rawBody.length > MAX_WEBHOOK_BYTES) {
      return Response.json({ error: 'Carga útil demasiado grande.' }, { status: 413 })
    }

    const validSignature = await verifySvixSignature(
      rawBody,
      request.headers,
      config.webhookSecret,
      nowProvider(),
    )
    if (!validSignature) {
      console.info('ordia_bank_email', { stage: 'signature', outcome: 'invalid_signature' })
      return Response.json({ error: 'No autorizado.' }, { status: 401 })
    }

    let envelope: ResendWebhookEnvelope
    try {
      envelope = JSON.parse(rawBody) as ResendWebhookEnvelope
    } catch {
      return Response.json({ error: 'Formato JSON inválido.' }, { status: 400 })
    }

    if (envelope.type !== 'email.received') {
      return Response.json({ status: 'ignored', reason: 'unsupported_event' })
    }

    const emailId = envelope.data?.email_id?.trim() ?? ''
    if (!/^[A-Za-z0-9_-]{4,120}$/.test(emailId)) {
      return Response.json({ error: 'Identificador de entrega inválido.' }, { status: 400 })
    }

    let emailResponse: Response
    try {
      emailResponse = await fetcher(
        `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${config.resendApiKey.trim()}`,
            Accept: 'application/json',
          },
        },
      )
    } catch {
      return Response.json(
        { error: 'No se pudo consultar el mensaje recibido en el proveedor.' },
        { status: 502 },
      )
    }

    if (emailResponse.status === 404) {
      console.info('ordia_bank_email', { stage: 'fetch', outcome: 'email_not_found' })
      return Response.json({ status: 'ignored', reason: 'email_not_found' })
    }

    if (!emailResponse.ok) {
      return Response.json(
        { error: 'Error al obtener la entrega entrante desde el proveedor.' },
        { status: 502 },
      )
    }

    let receivedEmail: ReceivedEmailPayload
    try {
      receivedEmail = (await emailResponse.json()) as ReceivedEmailPayload
    } catch {
      return Response.json({ error: 'Respuesta inválida del proveedor de correo.' }, { status: 502 })
    }

    const aliasLocalPart = extractVerifiedAliasLocalPart({
      inboundDomain: config.inboundDomain,
      receivedFor: receivedEmail.received_for,
      emailTo: receivedEmail.to,
      webhookReceivedFor: envelope.data?.received_for,
      webhookTo: envelope.data?.to,
    })

    if (!aliasLocalPart) {
      console.info('ordia_bank_email', { stage: 'recipient', outcome: 'unmatched_recipient' })
      return Response.json({ status: 'ignored', reason: 'unmatched_recipient' })
    }

    const providerEventHash = await sha256Hex(`resend:email:${emailId}`)
    const rawMessageId = extractMessageIdHeader(receivedEmail)
    const messageIdHash = rawMessageId ? await sha256Hex(`msgid:${rawMessageId}`) : null

    async function diagnostic(stage: string, outcome: string) {
      try {
        const { error } = await admin.rpc('record_bank_email_diagnostic', {
          p_event_hash: providerEventHash, p_alias_local_part: aliasLocalPart,
          p_stage: stage, p_outcome: outcome,
        })
        if (error) console.warn('ordia_bank_email_diagnostic_unavailable')
      } catch { console.warn('ordia_bank_email_diagnostic_unavailable') }
    }
    const classification = classifyInboundEmail(receivedEmail)

    if (classification.kind === 'ignored') {
      await diagnostic('classification', classification.reason)
      return Response.json({ status: 'ignored', reason: classification.reason })
    }

    if (classification.kind === 'gmail_confirmation') {
      const { data, error } = await admin.rpc('record_bank_email_gmail_confirmation', {
        p_provider_event_hash: providerEventHash,
        p_alias_local_part: aliasLocalPart,
        p_message_id_hash: messageIdHash,
        p_confirmation_code: classification.confirmationCode,
        p_confirmation_url: classification.confirmationUrl,
      })

      if (error || !data) {
        return Response.json({ error: 'No se pudo procesar la confirmación de reenvío.' }, { status: 500 })
      }

      const result = data as RecordConfirmationRpcResult
      return Response.json({
        status: result.outcome === 'alias_not_found' || result.outcome === 'alias_inactive' ? 'ignored' : 'accepted',
        kind: 'gmail_confirmation',
        outcome: result.outcome,
      })
    }

    // classification.kind === 'bank_notification'
    const parsed = classification.parsed
    const { data, error } = await admin.rpc('ingest_movement_notice', {
      p_provider_event_hash: providerEventHash,
      p_alias_local_part: aliasLocalPart,
      p_message_id_hash: messageIdHash,
      p_bank_name: parsed.bank_name,
      p_notification_type: parsed.notification_type,
      p_amount: parsed.amount,
      p_occurred_on: parsed.occurred_on,
      p_occurred_time: parsed.occurred_time,
      p_provider_reference: parsed.provider_reference ?? null,
      p_correspondent_name: parsed.correspondent_name ?? null,
      p_municipality: parsed.municipality ?? null,
      p_merchant: parsed.merchant,
      p_account_last_digits: parsed.account_last_digits,
      p_card_last_digits: parsed.card_last_digits,
      p_card_type: parsed.card_type,
      p_counterparty_name: parsed.counterparty_name,
      p_counterparty_account_last_digits: parsed.counterparty_account_last_digits,
    })

    if (error || !data) {
      await diagnostic('ingest', 'ingest_failed')
      return Response.json({ error: 'No se pudo guardar el pendiente bancario.' }, { status: 500 })
    }

    const ingestResult = data as IngestNotificationRpcResult
    await diagnostic('ingest', ingestResult.outcome)

    if (ingestResult.outcome === 'alias_not_found' || ingestResult.outcome === 'alias_inactive') {
      return Response.json({ status: 'ignored', reason: ingestResult.outcome })
    }

    if (!ingestResult.user_id || !ingestResult.notification_id) {
      return Response.json({ status: 'duplicate', kind: 'bank_notification' })
    }
    let pushTotals = { processed: 0, sent: 0, failed: 0, invalid: 0, skipped: 0 }
    const sender = config.pushConfigured ? sendPush : null
    try {
      if (!ingestResult.is_new_notification) {
        // Solo reintenta reservas existentes: no notifica retroactivamente a nuevos dispositivos.
        pushTotals = await retryBankPush(admin, sender, ingestResult.notification_id)
      } else {
        const { data: subscriptions, error: subsError } = await admin.from('push_subscriptions')
          .select('id,user_id,endpoint,p256dh,auth').eq('user_id', ingestResult.user_id)
          .eq('active', true).eq('notify_bank_movements', true).order('id', { ascending: true })
        if (subsError) {
          await diagnostic('push', 'subscription_lookup_failed')
          return Response.json({ error: 'Pendiente guardado; no se pudo preparar el aviso push.' }, { status: 503 })
        }
        const targets = (subscriptions ?? []).filter((sub: PushTargetSubscription) => sub.user_id === ingestResult.user_id)
        pushTotals = await sendBankPushTargets(admin, targets, sender, ingestResult.notification_id)
        if (!targets.length) await diagnostic('push', 'no_enabled_devices')
      }
      if (pushTotals.processed) await diagnostic('push', pushTotals.failed ? 'push_failed' : pushTotals.invalid ? 'subscription_invalid' : pushTotals.sent ? 'provider_accepted' : 'state_changed')
    } catch {
      await diagnostic('push', 'push_retry_unavailable')
    }
    return Response.json({
      status: ingestResult.is_new_notification ? 'accepted' : 'duplicate',
      kind: 'bank_notification',
      push: pushTotals,
    })
  }
}
