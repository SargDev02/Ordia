import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'
import {
  createBankEmailWebhookHandler,
  type PushTargetSubscription,
} from '../_shared/bank-email/handler.ts'

Deno.serve(async (request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const secretKeysRaw = Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'
  const legacyServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  let adminKey = legacyServiceRoleKey
  try {
    const parsedKeys = JSON.parse(secretKeysRaw) as Record<string, string>
    if (parsedKeys.default) {
      adminKey = parsedKeys.default
    }
  } catch {
    // Conservar clave heredada si SUPABASE_SECRET_KEYS no es JSON válido
  }

  if (!supabaseUrl || !adminKey) {
    return Response.json({ error: 'No hay credenciales de servidor disponibles.' }, { status: 503 })
  }

  const webhookSecret = Deno.env.get('RESEND_WEBHOOK_SECRET') ?? ''
  const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? ''
  const inboundDomain = Deno.env.get('BANK_INBOUND_EMAIL_DOMAIN') ?? ''

  const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY') ?? ''
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY') ?? ''
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? ''
  const pushConfigured = Boolean(vapidPublicKey && vapidPrivateKey && vapidSubject)

  if (pushConfigured) {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)
  }

  const admin = createClient(supabaseUrl, adminKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const sendPush = pushConfigured
    ? async (subscription: PushTargetSubscription, payload: string) => {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { auth: subscription.auth, p256dh: subscription.p256dh },
          },
          payload,
          { TTL: 60 * 60 * 12, urgency: 'high' },
        )
      }
    : null

  const handler = createBankEmailWebhookHandler(
    {
      webhookSecret,
      resendApiKey,
      inboundDomain,
      pushConfigured,
    },
    admin,
    sendPush,
  )

  return handler(request)
})
