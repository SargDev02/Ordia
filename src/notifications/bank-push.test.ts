import type { SupabaseClient } from '@supabase/supabase-js'
import { expect, it, vi } from 'vitest'
import { retryBankPush, sendBankPushTargets } from '../../supabase/functions/_shared/bank-push'

const target = { id: 'device', user_id: 'owner', endpoint: 'https://push.example.test/private', p256dh: 'synthetic-key', auth: 'synthetic-auth', bank_notification_id: 'notice' }
function client() {
  const rpc = vi.fn(async (name: string) => ({ data: name.startsWith('claim_') ? 'attempt' : name.startsWith('is_') ? true : null, error: null }))
  return { rpc, admin: { rpc } as unknown as SupabaseClient }
}

it.each([404, 410, 429, 503])('clasifica respuesta %s, no expone datos y completa la reserva sin afectar el pendiente', async (statusCode) => {
  const { rpc, admin } = client()
  const send = vi.fn().mockRejectedValue({ statusCode, message: 'never log endpoint or secret' })
  const totals = await sendBankPushTargets(admin, [target], send)
  expect(rpc).toHaveBeenCalledWith('complete_bank_push_notification_attempt', expect.objectContaining({ p_status: statusCode === 404 || statusCode === 410 ? 'invalid' : 'failed', p_http_status: statusCode }))
  expect(totals.invalid + totals.failed).toBe(1)
  const payload = JSON.parse(send.mock.calls[0][1])
  expect(payload).toEqual({ kind: 'bank_movement_pending', tag: 'ordia-bank-attempt' })
  expect(rpc.mock.calls.every(([name]) => !/ingest|transaction|dismiss/.test(name))).toBe(true)
})

it('revalida preferencias antes de enviar y no envía si el dispositivo se desactivó', async () => {
  const { rpc, admin } = client()
  rpc.mockResolvedValueOnce({ data: 'attempt', error: null }).mockResolvedValueOnce({ data: false, error: null })
  const send = vi.fn()
  expect((await sendBankPushTargets(admin, [target], send)).skipped).toBe(1)
  expect(send).not.toHaveBeenCalled()
})

it('reserva un fallo recuperable de configuración sin perder el pendiente', async () => {
  const { rpc, admin } = client()
  expect((await sendBankPushTargets(admin, [target], null)).failed).toBe(1)
  expect(rpc).toHaveBeenCalledWith('complete_bank_push_notification_attempt', expect.objectContaining({ p_status: 'failed', p_error_code: 'push_configuration_missing' }))
})

it('recupera solo las reservas entregadas por el servidor, sin consultar todos los dispositivos', async () => {
  const { rpc, admin } = client()
  rpc.mockResolvedValueOnce({ data: [target] as never, error: null })
  const send = vi.fn().mockResolvedValue(undefined)
  expect((await retryBankPush(admin, send, 'notice')).sent).toBe(1)
  expect(rpc).toHaveBeenCalledWith('list_bank_push_retry_targets', { p_notification_id: 'notice', p_limit: 100 })
  expect(send).toHaveBeenCalledOnce()
})
