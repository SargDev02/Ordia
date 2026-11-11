import { webcrypto } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createBankEmailWebhookHandler,
  type BankEmailWebhookConfig,
  type PushTargetSubscription,
} from '../../supabase/functions/_shared/bank-email/handler'
import {
  classifyInboundEmail,
  extractVerifiedAliasLocalPart,
  htmlToSafePlainText,
  verifySvixSignature,
  type ReceivedEmailPayload,
} from '../../supabase/functions/_shared/bank-email/mime-and-auth'

const RAW_SECRET_BYTES = new Uint8Array(32).fill(42)
const WEBHOOK_SECRET = `whsec_${Buffer.from(RAW_SECRET_BYTES).toString('base64')}`
const INBOUND_DOMAIN = 'avisos-prueba.resend.app'
const FIXED_NOW = 1_793_550_000
const CASH_DEPOSIT_NOTICE = 'Bancolombia: Recibiste una consignacion por $3,000 desde el corresponsal LA UNION HOSPITAL en LA UNION, el 09/06/26 17:04. Si tienes dudas, llamanos: 018000931987. A tu lado siempre.'

const ALIAS_USER_A = 'bnc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ALIAS_USER_B = 'bnc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ALIAS_OLD_REPLACED = 'bnc_cccccccccccccccccccccccccccccccc'

const baseConfig: BankEmailWebhookConfig = {
  webhookSecret: WEBHOOK_SECRET,
  resendApiKey: 're_test_fixture_key',
  inboundDomain: INBOUND_DOMAIN,
  pushConfigured: true,
}

async function signSvixPayload(
  body: string,
  secret = WEBHOOK_SECRET,
  svixId = 'msg_test_1',
  timestamp = FIXED_NOW,
) {
  const rawKey = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const key = await webcrypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const toSign = new TextEncoder().encode(`${svixId}.${timestamp}.${body}`)
  const sig = await webcrypto.subtle.sign('HMAC', key, toSign)
  const sigB64 = Buffer.from(sig).toString('base64')
  return {
    'content-type': 'application/json',
    'svix-id': svixId,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${sigB64}`,
  }
}

async function buildSignedRequest(
  envelope: unknown,
  options?: { secret?: string; svixId?: string; timestamp?: number },
) {
  const body = JSON.stringify(envelope)
  const headers = await signSvixPayload(
    body,
    options?.secret ?? WEBHOOK_SECRET,
    options?.svixId ?? 'msg_test_1',
    options?.timestamp ?? FIXED_NOW,
  )
  return new Request('https://project.supabase.co/functions/v1/bank-email-webhook', {
    method: 'POST',
    headers,
    body,
  })
}

function createFakeAdmin(subscriptionsByUser: Record<string, PushTargetSubscription[]> = {}) {
  const rpc = vi.fn()
  const eqChain = (filters: Record<string, unknown>) => ({
    eq(col: string, val: unknown) {
      return eqChain({ ...filters, [col]: val })
    },
    order: vi.fn().mockImplementation(async () => {
      const userId = String(filters.user_id ?? '')
      const rows = (subscriptionsByUser[userId] ?? []).filter(
        () => filters.active === true && filters.notify_bank_movements === true,
      )
      return { data: rows, error: null }
    }),
  })
  const from = vi.fn().mockImplementation(() => ({
    select: () => eqChain({}),
  }))

  return {
    rpc,
    from,
    client: { rpc, from } as unknown as SupabaseClient,
  }
}

describe('recepción automática de avisos bancarios (webhook, autenticación y Web Push)', () => {
  it('recibe la consignación por corresponsal en texto y HTML con las mismas reglas del pegado', async () => {
    for (const body of [{ text: CASH_DEPOSIT_NOTICE }, { html: `<p>${CASH_DEPOSIT_NOTICE.replace('consignacion', 'consignación')}</p>` }]) {
      const email = { id: 'deposit-test', from: 'alertasynotificaciones@an.bancolombia.com.co', received_for: `${ALIAS_USER_A}@${INBOUND_DOMAIN}`, authentication: { dmarc: 'pass', dkim: 'pass' }, ...body }
      const classified = classifyInboundEmail(email)
      expect(classified).toMatchObject({ kind: 'bank_notification', parsed: { notification_type: 'cash_deposit_received', amount: 3000, occurred_on: '2026-06-09', occurred_time: '17:04', correspondent_name: 'LA UNION HOSPITAL', municipality: 'LA UNION', counterparty_name: null, account_last_digits: null } })
      const admin = createFakeAdmin()
      admin.rpc.mockResolvedValue({ data: { outcome: 'created', is_new_notification: true, user_id: 'user-a', notification_id: 'deposit-1' }, error: null })
      const handler = createBankEmailWebhookHandler({ ...baseConfig, pushConfigured: false }, admin.client, null, vi.fn().mockResolvedValue(Response.json(email)), () => FIXED_NOW)
      const response = await handler(await buildSignedRequest({ type: 'email.received', data: { email_id: email.id } }))
      expect((await response.json()).status).toBe('accepted')
      expect(admin.rpc).toHaveBeenCalledWith('ingest_movement_notice', expect.objectContaining({ p_notification_type: 'cash_deposit_received', p_amount: 3000, p_correspondent_name: 'LA UNION HOSPITAL', p_municipality: 'LA UNION', p_counterparty_name: null, p_account_last_digits: null }))
      expect(classifyInboundEmail({ ...email, authentication: null }).kind).toBe('ignored')
      expect(classifyInboundEmail({ ...email, from: 'persona@example.test' }).kind).toBe('ignored')
    }
  })
  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('rechaza con 401 webhooks sin firma, con firma alterada o fuera de ventana temporal sin consultar Resend ni la BD', async () => {
    const admin = createFakeAdmin()
    const fetcher = vi.fn()
    const sendPush = vi.fn()
    const handler = createBankEmailWebhookHandler(
      baseConfig,
      admin.client,
      sendPush,
      fetcher,
      () => FIXED_NOW,
    )

    // 1. Sin cabeceras Svix
    const unauthReq = new Request('https://project.supabase.co/functions/v1/bank-email-webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'email.received', data: { email_id: 'em_1' } }),
    })
    expect((await handler(unauthReq)).status).toBe(401)

    // 2. Firma con otro secreto
    const wrongSecret = `whsec_${Buffer.from(new Uint8Array(32).fill(7)).toString('base64')}`
    const badSigReq = await buildSignedRequest(
      { type: 'email.received', data: { email_id: 'em_1' } },
      { secret: wrongSecret },
    )
    expect((await handler(badSigReq)).status).toBe(401)

    // 3. Marca temporal vencida (> 300 s)
    const expiredReq = await buildSignedRequest(
      { type: 'email.received', data: { email_id: 'em_1' } },
      { timestamp: FIXED_NOW - 301 },
    )
    expect((await handler(expiredReq)).status).toBe(401)

    expect(fetcher).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()

    // Comprobar rotación con varias firmas v1 separadas por espacio
    const raw = '{"type":"email.received"}'
    const validHeaders = await signSvixPayload(raw)
    const multiHeaders = new Headers({
      ...validHeaders,
      'svix-signature': `v1,invalida== ${validHeaders['svix-signature']}`,
    })
    expect(await verifySvixSignature(raw, multiHeaders, WEBHOOK_SECRET, FIXED_NOW)).toBe(true)
  })

  it('resuelve el alias únicamente desde el destinatario verificado del dominio autorizado y rechaza entregas ambiguas', () => {
    // Coincidencia válida en receivedFor aunque emailTo o headers tengan otros correos
    expect(
      extractVerifiedAliasLocalPart({
        inboundDomain: INBOUND_DOMAIN,
        receivedFor: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
        emailTo: ['otro@gmail.com'],
      }),
    ).toBe(ALIAS_USER_A)

    // Rechaza dominio distinto
    expect(
      extractVerifiedAliasLocalPart({
        inboundDomain: INBOUND_DOMAIN,
        receivedFor: `${ALIAS_USER_A}@otro-dominio.com`,
      }),
    ).toBeNull()

    // Rechaza entrega con dos alias distintos de usuarios diferentes en el mismo correo
    expect(
      extractVerifiedAliasLocalPart({
        inboundDomain: INBOUND_DOMAIN,
        emailTo: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`, `${ALIAS_USER_B}@${INBOUND_DOMAIN}`],
      }),
    ).toBeNull()
  })

  it('procesa el correo de confirmación de Gmail sin abrir enlaces automáticamente ni crear movimientos bancarios', async () => {
    const admin = createFakeAdmin()
    admin.rpc.mockResolvedValueOnce({
      data: { outcome: 'recorded', updated: true, user_id: 'user-a' },
      error: null,
    })

    const gmailVerificationEmail: ReceivedEmailPayload = {
      id: 'em_gmail_verify_a',
      from: 'Equipo de Gmail <forwarding-noreply@google.com>',
      to: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
      received_for: `${ALIAS_USER_A}@${INBOUND_DOMAIN}`,
      subject: `Confirmación de reenvío de Gmail - Recibir correo de usuario.a@gmail.com`,
      message_id: '<gmail-confirm-1@google.com>',
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      text: [
        `usuario.a@gmail.com ha solicitado reenviar automáticamente el correo a tu dirección ${ALIAS_USER_A}@${INBOUND_DOMAIN}.`,
        'Código de confirmación: 847291034',
        'Para confirmar esta solicitud, haz clic en el enlace siguiente:',
        'https://isolated.mail.google.com/mail/vf-%5BANGjdJ8confirmTokenA%5D-verify',
        'Si recibiste este mensaje por error, haz clic en el enlace siguiente para cancelar esta verificación:',
        'https://isolated.mail.google.com/mail/uf-%5BANGjdJ8cancelTokenA%5D-cancel',
      ].join('\n'),
    }

    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(gmailVerificationEmail))
    const sendPush = vi.fn()
    const handler = createBankEmailWebhookHandler(
      baseConfig,
      admin.client,
      sendPush,
      fetcher,
      () => FIXED_NOW,
    )

    const req = await buildSignedRequest({
      type: 'email.received',
      data: { email_id: 'em_gmail_verify_a', to: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`] },
    })

    const res = await handler(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'accepted',
      kind: 'gmail_confirmation',
      outcome: 'recorded',
    })

    // Solo consultó la API de Resend; NUNCA abrió automáticamente el enlace de Google Mail
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api.resend.com/emails/receiving/em_gmail_verify_a',
    )

    // Guardó código y URL de confirmación (no la de cancelación) en el alias del usuario A
    expect(admin.rpc).toHaveBeenCalledTimes(1)
    expect(admin.rpc).toHaveBeenCalledWith('record_bank_email_gmail_confirmation', {
      p_provider_event_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_alias_local_part: ALIAS_USER_A,
      p_message_id_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_confirmation_code: '847291034',
      p_confirmation_url:
        'https://isolated.mail.google.com/mail/vf-%5BANGjdJ8confirmTokenA%5D-verify',
    })
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('ignora mensajes no autenticados, reenvíos manuales desde @gmail.com y correos ajenos sin tocar saldos ni avisos', async () => {
    const admin = createFakeAdmin()
    const sendPush = vi.fn()

    // Caso 1: Remitente aparenta Bancolombia pero falla DKIM/DMARC/ARC
    const spoofed: ReceivedEmailPayload = {
      id: 'em_spoof',
      from: 'alertasynotificaciones@bancolombia.com.co',
      received_for: `${ALIAS_USER_A}@${INBOUND_DOMAIN}`,
      authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
      text: 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    }
    expect(classifyInboundEmail(spoofed)).toEqual({
      kind: 'ignored',
      reason: 'failed_email_authentication',
    })

    // Caso 2: Reenvío manual con botón "Reenviar" donde From pasa a ser el Gmail del usuario
    const manualForward: ReceivedEmailPayload = {
      id: 'em_manual_fwd',
      from: 'persona@gmail.com',
      received_for: `${ALIAS_USER_A}@${INBOUND_DOMAIN}`,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      text: '---------- Forwarded message ---------\nBancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    }
    expect(classifyInboundEmail(manualForward)).toEqual({
      kind: 'ignored',
      reason: 'unverified_sender',
    })

    // Caso 3: Correo promocional auténtico de Bancolombia sin estructura de operación
    const promoEmail: ReceivedEmailPayload = {
      id: 'em_promo',
      from: 'alertasynotificaciones@bancolombia.com.co',
      received_for: `${ALIAS_USER_A}@${INBOUND_DOMAIN}`,
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      subject: 'Novedades de seguridad Bancolombia',
      text: 'Conoce nuestros consejos para cuidar tus claves en canales digitales.',
    }

    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(promoEmail))
    const handler = createBankEmailWebhookHandler(
      baseConfig,
      admin.client,
      sendPush,
      fetcher,
      () => FIXED_NOW,
    )

    const res = await handler(
      await buildSignedRequest({ type: 'email.received', data: { email_id: 'em_promo' } }),
    )
    expect(await res.json()).toEqual({ status: 'ignored', reason: 'unrecognized_content' })
    expect(admin.rpc).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()
  })

  it('reconoce exactamente los 3 ejemplos de Bancolombia (22000, 39900 y 200000 COP) en texto y HTML con reenvío ARC de Gmail sin ejecutar HTML', () => {
    // Comprobar que htmlToSafePlainText elimina <script>, <style> e <iframe> sin ejecutar nada
    const rawHtmlSample = `
      <html>
        <head><style>.hidden { color: red; }</style></head>
        <body>
          <script>throw new Error("Nunca debe ejecutarse")</script>
          <table>
            <tr><td><img src="https://bancolombia.com/logo.png" alt="Bancolombia" /></td></tr>
            <tr><td>Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.</td></tr>
          </table>
          <p>Bancolombia nunca te solicitará tus claves ni códigos dinámicos.</p>
          <p>Línea de atención nacional 01 8000 912345.</p>
        </body>
      </html>
    `
    const safePlain = htmlToSafePlainText(rawHtmlSample)
    expect(safePlain).not.toContain('throw new Error')
    expect(safePlain).toContain('Bancolombia')
    expect(safePlain).toContain('$39.900,00')

    // Ejemplo 1: $22,000 -> 22000 (DKIM directo)
    const ex1 = classifyInboundEmail({
      id: 'em_ex1',
      from: 'Alertas y Notificaciones <alertasynotificaciones@bancolombia.com.co>',
      authentication: { dkim: 'pass', dmarc: 'pass' },
      text: 'Bancolombia: Recibiste una transferencia por $22,000 de "" en tu cuenta **8422, el 31/10/2026 a las 13:28.',
    })
    expect(ex1).toEqual({
      kind: 'bank_notification',
      authMechanism: 'direct_dkim_dmarc',
      parsed: {
        bank_name: 'Bancolombia',
        notification_type: 'transfer_received',
        amount: 22000,
        occurred_on: '2026-10-31',
        occurred_time: '13:28',
        merchant: null,
        account_last_digits: '8422',
        card_last_digits: null,
        card_type: null,
        counterparty_name: null,
        counterparty_account_last_digits: null,
      },
    })

    // Ejemplo 2: $39.900,00 -> 39900 en HTML con firma DKIM auténtica de Bancolombia verificada por el receptor
    const ex2 = classifyInboundEmail({
      id: 'em_ex2',
      from: 'alertasynotificaciones@notificacionesbancolombia.com',
      authentication: { dkim: 'pass', dmarc: 'pass' },
      headers: {
        'dkim-signature':
          'v=1; a=rsa-sha256; c=relaxed/relaxed; d=notificacionesbancolombia.com; s=s1; t=1729171020; h=from:to:subject:date; bh=xyz; b=abc',
        'X-Forwarded-To': `${ALIAS_USER_A}@${INBOUND_DOMAIN}`,
      },
      html: rawHtmlSample,
    })
    expect(ex2).toEqual({
      kind: 'bank_notification',
      authMechanism: 'direct_dkim_dmarc',
      parsed: {
        bank_name: 'Bancolombia',
        notification_type: 'purchase',
        amount: 39900,
        occurred_on: '2026-10-17',
        occurred_time: '13:17',
        merchant: 'HOMECENTER RIONEGRO',
        account_last_digits: null,
        card_last_digits: '0541',
        card_type: 'debit',
        counterparty_name: null,
        counterparty_account_last_digits: null,
      },
    })

    // Ejemplo 3: $200,000.00 -> 200000 con cabecera de reenvío y año de 2 dígitos
    const ex3 = classifyInboundEmail({
      id: 'em_ex3',
      from: 'alertasynotificaciones@bancolombia.com.co',
      authentication: { dkim: 'pass' },
      text: [
        '---------- Mensaje reenviado ---------',
        'De: Alertas y Notificaciones <alertasynotificaciones@bancolombia.com.co>',
        'Fecha: mar, 20 oct 2026 a las 21:15',
        'Asunto: Alertas y Notificaciones',
        `Para: <usuario@gmail.com>`,
        '',
        'Bancolombia: Transferiste $200,000.00 desde tu cuenta *8422 a la cuenta *"" el 20/10/26 a las 21:15.',
      ].join('\n'),
    })
    expect(ex3).toEqual({
      kind: 'bank_notification',
      authMechanism: 'direct_dkim_dmarc',
      parsed: {
        bank_name: 'Bancolombia',
        notification_type: 'transfer_sent',
        amount: 200000,
        occurred_on: '2026-10-20',
        occurred_time: '21:15',
        merchant: null,
        account_last_digits: '8422',
        card_last_digits: null,
        card_type: null,
        counterparty_name: null,
        counterparty_account_last_digits: null,
      },
    })
  })

  it('clasifica QR en texto y HTML con autenticación bancaria sin aceptar un pagaste aislado', () => {
    const text = 'Bancolombia: PERSONA DE PRUEBA pagaste $64,000.00 por codigo QR desde tu cuenta *1234 a la llave 0000123456 el 08/11/2026 a las 10:03. Con codigo QR es facil y de una.'
    for (const from of ['alertasynotificaciones@an.bancolombia.com.co', 'alertasynotificaciones@ayn.bancolombia.com.co']) {
      for (const content of [{ text }, { html: `<p>${text.replace('codigo QR', 'código QR')}</p><footer>Línea: 3001234567</footer>` }]) {
        const result = classifyInboundEmail({ id: 'em_qr', from, authentication: { dkim: 'pass', dmarc: 'pass' }, ...content })
        expect(result.kind).toBe('bank_notification')
        if (result.kind === 'bank_notification') expect(result.parsed).toMatchObject({ amount: 64000, notification_type: 'purchase', account_last_digits: '1234', merchant: null })
      }
    }
    expect(classifyInboundEmail({ id: 'em_bad', from: 'alertasynotificaciones@an.bancolombia.com.co', authentication: { dkim: 'pass' }, text: text.replace('por codigo QR', 'en una tienda') }).kind).toBe('ignored')
    expect(classifyInboundEmail({ id: 'em_spoof', from: 'atacante@ejemplo.com', authentication: { dkim: 'pass', dmarc: 'pass' }, text }).kind).toBe('ignored')
  })

  it('acepta PSE solo del remitente exacto con autenticación alineada y estado aprobado', async () => {
    const text = 'Estado de la Transacción: Aprobada\nValor: $ 27.500,00\nEmpresa: EMPRESA DE PRUEBA S.A.S.\nDescripción: COMPRA DE PRUEBA\nFecha de la transacción: 07/11/2026\nCUS: 000123456'
    const base: ReceivedEmailPayload = { id: 'em_pse', from: 'serviciopse@achcolombia.com.co', authentication: { dkim: 'pass', dmarc: 'pass' }, text }
    for (const content of [{ text }, { html: `<p>${text.split('\n').join('</p><p>')}</p>` }]) {
      const result = classifyInboundEmail({ ...base, text: null, ...content })
      expect(result.kind).toBe('bank_notification')
      if (result.kind === 'bank_notification') expect(result.parsed).toMatchObject({ bank_name: 'PSE/ACH Colombia', amount: 27500, occurred_on: '2026-11-07', occurred_time: null, provider_reference: '000123456', account_last_digits: null })
    }
    for (const email of [
      { ...base, from: 'otro@achcolombia.com.co' },
      { ...base, authentication: { dkim: 'pass', dmarc: 'fail' } },
      { ...base, authentication: { dkim: 'pass' }, headers: { 'dkim-signature': 'd=achcolombia.com.co; b=abc' } },
      { ...base, authentication: { dkim: 'pass' }, headers: { 'dkim-signature': 'd=atacante.com; b=abc' } },
      { ...base, authentication: null },
      { ...base, text: text.replace('Aprobada', 'Rechazada') },
      { ...base, text: `${text}\nEstado de la Transacción: Pendiente` },
      { ...base, html: `<p>${text.replace('Aprobada', 'Rechazada').split('\n').join('</p><p>')}</p>` },
      { ...base, text: text.replace('27.500,00', '27.500,50') },
    ]) expect(classifyInboundEmail(email).kind).toBe('ignored')

    const admin = createFakeAdmin()
    admin.rpc.mockResolvedValue({ data: { outcome: 'created', is_new_notification: true, user_id: 'user-a', notification_id: 'notif-pse' }, error: null })
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...base, received_for: `${ALIAS_USER_A}@${INBOUND_DOMAIN}` }))
    const handler = createBankEmailWebhookHandler({ ...baseConfig, pushConfigured: false }, admin.client, null, fetcher, () => FIXED_NOW)
    const response = await handler(await buildSignedRequest({ type: 'email.received', data: { email_id: 'em_pse', received_for: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`] } }))
    expect((await response.json()).status).toBe('accepted')
    expect(admin.rpc).toHaveBeenCalledWith('ingest_movement_notice', expect.objectContaining({ p_alias_local_part: ALIAS_USER_A, p_provider_reference: '000123456', p_occurred_time: null, p_amount: 27500 }))
  })

  it('aísla usuarios A y B, rechaza alias desactivados/reemplazados, evita duplicados en reintentos, acepta dos compras legítimas similares y mantiene el pendiente si falla el push', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const subUserA: PushTargetSubscription = {
      id: 'sub-user-a-iphone',
      user_id: 'user-a',
      endpoint: 'https://web.push.apple.com/device-a',
      p256dh: 'key-a',
      auth: 'auth-a',
    }
    const subUserB: PushTargetSubscription = {
      id: 'sub-user-b-android',
      user_id: 'user-b',
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-b',
      p256dh: 'key-b',
      auth: 'auth-b',
    }

    const admin = createFakeAdmin({
      'user-a': [subUserA],
      'user-b': [subUserB],
    })

    const pushedCalls: Array<{ sub: PushTargetSubscription; payload: string }> = []
    let failNextPush = false
    const sendPush = vi.fn().mockImplementation(async (sub: PushTargetSubscription, payload: string) => {
      if (failNextPush) {
        const err = new Error('Push gateway unavailable') as Error & { statusCode?: number }
        err.statusCode = 503
        throw err
      }
      pushedCalls.push({ sub, payload })
    })

    const emailsById: Record<string, ReceivedEmailPayload> = {
      // 1. Alias antiguo reemplazado de A
      em_old_alias: {
        id: 'em_old_alias',
        from: 'alertasynotificaciones@bancolombia.com.co',
        received_for: `${ALIAS_OLD_REPLACED}@${INBOUND_DOMAIN}`,
        message_id: '<msg-old@bancolombia.com.co>',
        authentication: { dkim: 'pass', dmarc: 'pass' },
        text: 'Bancolombia: Recibiste una transferencia por $22,000 de "" en tu cuenta **8422, el 31/10/2026 a las 13:28.',
      },
      // 2. Primera compra legítima de A ($39.900 en HOMECENTER a las 13:17)
      em_legit_1: {
        id: 'em_legit_1',
        from: 'alertasynotificaciones@bancolombia.com.co',
        received_for: `${ALIAS_USER_A}@${INBOUND_DOMAIN}`,
        message_id: '<msg-purchase-1@bancolombia.com.co>',
        authentication: { dkim: 'pass', dmarc: 'pass' },
        text: 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
      },
      // 3. Segunda compra legítima idéntica en monto, comercio y minuto pero operación distinta (Message-ID y email_id distintos)
      em_legit_2: {
        id: 'em_legit_2',
        from: 'alertasynotificaciones@bancolombia.com.co',
        received_for: `${ALIAS_USER_A}@${INBOUND_DOMAIN}`,
        message_id: '<msg-purchase-2@bancolombia.com.co>',
        authentication: { dkim: 'pass', dmarc: 'pass' },
        text: 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
      },
    }

    const fetcher = vi.fn().mockImplementation(async (url: string) => {
      const id = String(url).split('/').pop() ?? ''
      const found = emailsById[id]
      return found ? Response.json(found) : new Response(null, { status: 404 })
    })

    const handler = createBankEmailWebhookHandler(
      baseConfig,
      admin.client,
      sendPush,
      fetcher,
      () => FIXED_NOW,
    )

    // A) Entrega a dirección desactivada o reemplazada -> ignorada, sin push
    admin.rpc.mockResolvedValueOnce({
      data: { outcome: 'alias_inactive', is_new_notification: false },
      error: null,
    })
    const resInactive = await handler(
      await buildSignedRequest({ type: 'email.received', data: { email_id: 'em_old_alias' } }),
    )
    expect(await resInactive.json()).toEqual({ status: 'ignored', reason: 'alias_inactive' })
    expect(sendPush).not.toHaveBeenCalled()

    // B) Entrega válida 1 para Usuario A -> crea pendiente y envía push discreto SOLO al dispositivo de A
    admin.rpc
      .mockResolvedValueOnce({
        data: {
          outcome: 'created',
          is_new_notification: true,
          user_id: 'user-a',
          notification_id: 'notif-a-1',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: 'attempt-a-1', error: null }) // claim_bank_push_notification_attempt
      .mockResolvedValueOnce({ data: true, error: null }) // is_bank_push_notification_attempt_deliverable
      .mockResolvedValueOnce({ data: null, error: null }) // complete_bank_push_notification_attempt

    const res1 = await handler(
      await buildSignedRequest({ type: 'email.received', data: { email_id: 'em_legit_1' } }),
    )
    expect(await res1.json()).toEqual({
      status: 'accepted',
      kind: 'bank_notification',
      push: { processed: 1, sent: 1, failed: 0, invalid: 0, skipped: 0 },
    })

    // Verificar que el dispositivo de B NUNCA recibió el aviso de A y el payload no expone monto, comercio ni cuenta
    expect(pushedCalls).toHaveLength(1)
    expect(pushedCalls[0]?.sub.id).toBe('sub-user-a-iphone')
    expect(pushedCalls[0]?.payload).not.toContain('39900')
    expect(pushedCalls[0]?.payload).not.toContain('HOMECENTER')
    expect(pushedCalls[0]?.payload).not.toContain('0541')
    expect(JSON.parse(pushedCalls[0]!.payload)).toEqual({
      kind: 'bank_movement_pending',
      tag: 'ordia-bank-attempt-a-1',
    })

    // C) Reintento del proveedor del mismo correo em_legit_1 -> duplicado, NO vuelve a notificar
    admin.rpc.mockResolvedValueOnce({
      data: {
        outcome: 'duplicate',
        is_new_notification: false,
        user_id: 'user-a',
        notification_id: 'notif-a-1',
      },
      error: null,
    })
    const resRetry = await handler(
      await buildSignedRequest({ type: 'email.received', data: { email_id: 'em_legit_1' } }),
    )
    expect(await resRetry.json()).toEqual({
      status: 'duplicate',
      kind: 'bank_notification',
    })
    expect(pushedCalls).toHaveLength(1)

    // D) Segunda operación legítima similar (em_legit_2) cuando falla el servicio Web Push -> pendiente queda disponible (200 accepted)
    failNextPush = true
    admin.rpc
      .mockResolvedValueOnce({
        data: {
          outcome: 'created',
          is_new_notification: true,
          user_id: 'user-a',
          notification_id: 'notif-a-2',
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: 'attempt-a-2', error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: null })

    const res2 = await handler(
      await buildSignedRequest({ type: 'email.received', data: { email_id: 'em_legit_2' } }),
    )
    expect(res2.status).toBe(200)
    expect(await res2.json()).toEqual({
      status: 'accepted',
      kind: 'bank_notification',
      push: { processed: 1, sent: 0, failed: 1, invalid: 0, skipped: 0 },
    })

    // Verificar que nunca se registraron cuerpos de correo ni direcciones en consola
    expect(consoleLogSpy).not.toHaveBeenCalled()
    expect(consoleWarnSpy).not.toHaveBeenCalled()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('rechaza correos falsificados aunque el webhook tenga firma válida y simulen From, Authentication-Results, ARC-Authentication-Results, X-Forwarded-To o cabeceras contradictorias', async () => {
    const admin = createFakeAdmin()
    const sendPush = vi.fn()

    // 1. Webhook con firma válida de prueba, pero correo falsifica From, Authentication-Results, ARC y X-Forwarded-To
    const spoofedBankEmail: ReceivedEmailPayload = {
      id: 'em_spoofed_bank',
      from: 'Bancolombia <notificaciones@notificacionesbancolombia.com>',
      to: ['usuario-visible@gmail.com'], // Destinatario visible distinto del destinatario real de entrega
      received_for: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
      subject: 'Notificación de compra',
      headers: {
        from: [
          'Bancolombia <notificaciones@notificacionesbancolombia.com>',
          'attacker@evil.com',
        ], // Cabeceras From duplicadas/contradictorias
        to: 'usuario-visible@gmail.com',
        'delivered-to': `bnc_fakevictim00000000000000000000@${INBOUND_DOMAIN}`, // Intento de inyectar cabecera de entrega
        'authentication-results':
          'mx.google.com; dkim=pass header.i=@notificacionesbancolombia.com; spf=pass', // Falsificada en cuerpo
        'arc-authentication-results':
          'i=1; mx.google.com; dkim=pass header.i=@notificacionesbancolombia.com; spf=pass', // Falsificada en cuerpo
        'x-forwarded-to': `${ALIAS_USER_A}@${INBOUND_DOMAIN}`, // Falsificada en cuerpo
      },
      // Resend evalúa la conexión real: no procede de Bancolombia ni pasa DKIM
      authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' },
      text: 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    }

    // 2. Falsificación de confirmación de Gmail con firma Svix válida
    const spoofedGoogleEmail: ReceivedEmailPayload = {
      id: 'em_spoofed_google',
      from: 'Equipo de Gmail <forwarding-noreply@google.com>',
      to: ['visible@otro.com'],
      received_for: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
      headers: {
        from: 'Equipo de Gmail <forwarding-noreply@google.com>',
        to: 'visible@otro.com',
        'authentication-results': 'mx.google.com; dkim=pass header.i=@google.com',
        'arc-authentication-results': 'i=1; mx.google.com; dkim=pass',
      },
      authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' }, // Resend no autentica a Google
      text: 'Código de confirmación: 123456789. Haz clic en https://mail.google.com/mail/vf-fake',
    }

    // 3. Caso legítimo con destinatario visible en cabecera distinto del destinatario real de entrega
    // (comportamiento normal tras un reenvío: To: es el correo personal del usuario en Gmail,
    // mientras received_for es el alias privado en Resend)
    const legitDiffVisibleEmail: ReceivedEmailPayload = {
      id: 'em_legit_diff_visible',
      from: 'alertasynotificaciones@notificacionesbancolombia.com',
      to: ['usuario.personal@gmail.com'], // Destinatario visible
      received_for: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`], // Destinatario real de entrega en sobre SMTP
      headers: {
        from: 'alertasynotificaciones@notificacionesbancolombia.com',
        to: 'usuario.personal@gmail.com',
        'dkim-signature':
          'v=1; a=rsa-sha256; c=relaxed/relaxed; d=notificacionesbancolombia.com; s=s1; bh=z; b=w',
      },
      authentication: { dkim: 'pass', dmarc: 'pass' },
      text: 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    }

    const fetcher = vi.fn().mockImplementation(async (url: string) => {
      const id = String(url).split('/').pop()
      if (id === 'em_spoofed_bank') return Response.json(spoofedBankEmail)
      if (id === 'em_spoofed_google') return Response.json(spoofedGoogleEmail)
      if (id === 'em_legit_diff_visible') return Response.json(legitDiffVisibleEmail)
      return new Response(null, { status: 404 })
    })

    const handler = createBankEmailWebhookHandler(
      baseConfig,
      admin.client,
      sendPush,
      fetcher,
      () => FIXED_NOW,
    )

    // El POST del webhook de banco falsificado tiene firma criptográfica Svix válida:
    const signedSpoofedReq = await buildSignedRequest({
      type: 'email.received',
      data: {
        email_id: 'em_spoofed_bank',
        to: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
        received_for: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
      },
    })

    const resBank = await handler(signedSpoofedReq)
    expect(resBank.status).toBe(200)
    const jsonBank = await resBank.json()
    // No debe crear pendiente ni enviar push:
    expect(jsonBank.status).toBe('ignored')
    expect(['unverified_sender', 'failed_email_authentication']).toContain(jsonBank.reason)
    expect(admin.rpc).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()

    // El POST del webhook de Google falsificado tiene firma Svix válida:
    const signedGoogleReq = await buildSignedRequest({
      type: 'email.received',
      data: {
        email_id: 'em_spoofed_google',
        to: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
        received_for: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
      },
    })

    const resGoogle = await handler(signedGoogleReq)
    expect(resGoogle.status).toBe(200)
    const jsonGoogle = await resGoogle.json()
    expect(jsonGoogle.status).toBe('ignored')
    expect(admin.rpc).not.toHaveBeenCalled()
    expect(sendPush).not.toHaveBeenCalled()

    // Sub-caso: Atacante firma con DKIM de su propio dominio (atacante.com) pero simula From de Bancolombia
    const attackerDkimEmail: ReceivedEmailPayload = {
      id: 'em_attacker_dkim',
      from: 'alertasynotificaciones@notificacionesbancolombia.com',
      received_for: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
      headers: {
        from: 'alertasynotificaciones@notificacionesbancolombia.com',
        'dkim-signature': 'v=1; a=rsa-sha256; d=atacante.com; s=s1; h=from:to; bh=x; b=y',
      },
      // Resend valida que la firma de atacante.com pasa, pero DMARC falla por desalineación con From
      authentication: { spf: 'fail', dkim: 'pass', dmarc: 'fail' },
      text: 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    }
    expect(classifyInboundEmail(attackerDkimEmail)).toEqual({
      kind: 'ignored',
      reason: 'failed_email_authentication',
    })

    // Caso legítimo con destinatario visible distinto del real de entrega:
    admin.rpc.mockResolvedValueOnce({
      data: {
        outcome: 'created',
        is_new_notification: true,
        user_id: 'user-a',
        notification_id: 'notif-diff-visible',
      },
      error: null,
    })

    const signedLegitReq = await buildSignedRequest({
      type: 'email.received',
      data: {
        email_id: 'em_legit_diff_visible',
        to: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
        received_for: [`${ALIAS_USER_A}@${INBOUND_DOMAIN}`],
      },
    })

    const resLegit = await handler(signedLegitReq)
    expect(resLegit.status).toBe(200)
    expect(await resLegit.json()).toEqual({
      status: 'accepted',
      kind: 'bank_notification',
      push: { processed: 0, sent: 0, failed: 0, invalid: 0, skipped: 0 },
    })

    // Comprobar que se vinculó al alias real del sobre y no al destinatario visible
    expect(admin.rpc).toHaveBeenCalledWith(
      'ingest_movement_notice',
      expect.objectContaining({
        p_alias_local_part: ALIAS_USER_A,
        p_amount: 39900,
      }),
    )
  })
})
