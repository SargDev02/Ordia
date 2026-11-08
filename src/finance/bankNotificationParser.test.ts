import { describe, expect, it } from 'vitest'
import {
  isTransactionCompatibleWithNotification,
  parseBancolombiaNotification,
  parseMovementNotice,
  parseCopAmount,
  resolveKnownAccountId,
} from './bankNotificationParser'
import { parsePseReceipt } from '../../supabase/functions/_shared/bank-email/parser'
import type { BankCardAccountLink, BankNotification, FinancialAccount, FinancialTransaction } from '../types/finance'

describe('parseCopAmount', () => {
  it('parsea importes con coma o punto como separador de miles', () => {
    expect(parseCopAmount('$22,000')).toBe(22000)
    expect(parseCopAmount('$50.000')).toBe(50000)
    expect(parseCopAmount('$1.500.000')).toBe(1500000)
    expect(parseCopAmount('$1,500,000')).toBe(1500000)
    expect(parseCopAmount('$500')).toBe(500)
  })

  it('parsea importes con dos decimales de centavos (,00 o .00) descartando centavos en pesos', () => {
    expect(parseCopAmount('$39.900,00')).toBe(39900)
    expect(parseCopAmount('$200,000.00')).toBe(200000)
    expect(parseCopAmount('$1.250.000,00')).toBe(1250000)
    expect(parseCopAmount('$1,250,000.00')).toBe(1250000)
    expect(parseCopAmount('39900,00')).toBe(39900)
    expect(parseCopAmount('200000.00')).toBe(200000)
  })

  it('retorna null ante valores no numéricos o vacíos', () => {
    expect(parseCopAmount('')).toBeNull()
    expect(parseCopAmount('   ')).toBeNull()
    expect(parseCopAmount('abc')).toBeNull()
    expect(parseCopAmount('$0')).toBeNull()
    expect(parseCopAmount('$-500')).toBeNull()
  })

  it('rechaza centavos distintos de cero y separadores inválidos o ambiguos sin redondear ni truncar', () => {
    expect(parseCopAmount('$39.900,50')).toBeNull()
    expect(parseCopAmount('$200,000.25')).toBeNull()
    expect(parseCopAmount('$22,000.01')).toBeNull()
    expect(parseCopAmount('$1.500,99')).toBeNull()
    expect(parseCopAmount('$39.900,5')).toBeNull()
    expect(parseCopAmount('$22.000.00')).toBeNull()
    expect(parseCopAmount('$22,000,00')).toBeNull()
    expect(parseCopAmount('$39.90,00')).toBeNull()
    expect(parseCopAmount('$12,34')).toBeNull()
    expect(parseCopAmount('$22 000')).toBeNull()
  })
})

describe('parseBancolombiaNotification con los tres ejemplos de referencia', () => {
  it('ejemplo 1: transferencia recibida con remitente vacío y cuenta **8422', () => {
    const text = 'Bancolombia: Recibiste una transferencia por $22,000 de "" en tu cuenta **8422, el 31/10/2026 a las 13:28.'
    const result = parseBancolombiaNotification(text)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.bank_name).toBe('Bancolombia')
    expect(result.data.notification_type).toBe('transfer_received')
    expect(result.data.amount).toBe(22000)
    expect(result.data.occurred_on).toBe('2026-10-31')
    expect(result.data.occurred_time).toBe('13:28')
    expect(result.data.account_last_digits).toBe('8422')
    expect(result.data.card_last_digits).toBeNull()
    expect(result.data.card_type).toBeNull()
    expect(result.data.counterparty_name).toBeNull() // "" tratado como desconocido
    expect(result.data.counterparty_account_last_digits).toBeNull()
    expect(result.data.merchant).toBeNull()
  })

  it('ejemplo 2: compra débito en HOMECENTER RIONEGRO con tarjeta 0541', () => {
    const text = 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.'
    const result = parseBancolombiaNotification(text)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.bank_name).toBe('Bancolombia')
    expect(result.data.notification_type).toBe('purchase')
    expect(result.data.amount).toBe(39900)
    expect(result.data.occurred_on).toBe('2026-10-17')
    expect(result.data.occurred_time).toBe('13:17')
    expect(result.data.merchant).toBe('HOMECENTER RIONEGRO')
    expect(result.data.card_last_digits).toBe('0541')
    expect(result.data.card_type).toBe('debit')
    expect(result.data.account_last_digits).toBeNull() // Distingue tarjeta de cuenta
    expect(result.data.counterparty_name).toBeNull()
    expect(result.data.counterparty_account_last_digits).toBeNull()
  })

  it('ejemplo 3: transferencia enviada con año de 2 dígitos y cuenta destino vacía', () => {
    const text = 'Bancolombia: Transferiste $200,000.00 desde tu cuenta *8422 a la cuenta *"" el 20/10/26 a las 21:15.'
    const result = parseBancolombiaNotification(text)

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.bank_name).toBe('Bancolombia')
    expect(result.data.notification_type).toBe('transfer_sent')
    expect(result.data.amount).toBe(200000)
    expect(result.data.occurred_on).toBe('2026-10-20') // 20/10/26 -> 2026-10-20
    expect(result.data.occurred_time).toBe('21:15')
    expect(result.data.account_last_digits).toBe('8422')
    expect(result.data.counterparty_account_last_digits).toBeNull() // *"" tratado como desconocido
    expect(result.data.card_last_digits).toBeNull()
    expect(result.data.merchant).toBeNull()
  })
})

const QR_NOTICE = 'Bancolombia: PERSONA DE PRUEBA pagaste $64,000.00 por codigo QR desde tu cuenta *1234 a la llave 0000123456 el 08/11/2026 a las 10:03. Con codigo QR es facil y de una.'
const PSE_RECEIPT = `Estado de la Transacción: Aprobada
Valor: $ 27.500,00
Empresa: EMPRESA DE PRUEBA S.A.S.
Descripción: COMPRA DE PRUEBA
Fecha de la transacción: 07/11/2026
CUS: 000123456`

describe('nuevos formatos de movimientos por revisar', () => {
  it('interpreta el pago QR como gasto saliente sin atribuir nombre ni llave a una cuenta', () => {
    for (const notice of [QR_NOTICE, QR_NOTICE.replace('codigo QR', 'código QR'), `<p>Bancolombia: PERSONA DE PRUEBA <strong>pagaste</strong> $64,000.00 por código QR desde tu cuenta *1234 a la llave 0000123456 el 08/11/2026 a las 10:03.</p><p>Línea de atención: 3001234567</p>`]) {
      const result = parseMovementNotice(notice)
      expect(result.success).toBe(true)
      if (!result.success) continue
      expect(result.data).toMatchObject({ bank_name: 'Bancolombia', notification_type: 'purchase', amount: 64000, occurred_on: '2026-11-08', occurred_time: '10:03', account_last_digits: '1234', merchant: null, card_last_digits: null, counterparty_account_last_digits: null })
      expect(JSON.stringify(result.data)).not.toContain('0000123456')
      expect(JSON.stringify(result.data)).not.toContain('PERSONA DE PRUEBA')
    }
  })

  it('rechaza QR incompleto, fallido, con importe inválido o ambiguo', () => {
    for (const notice of [
      QR_NOTICE.replace('por codigo QR', 'en la tienda'),
      QR_NOTICE.replace('pagaste $64,000.00 por codigo QR', 'pagaste en un comercio'),
      QR_NOTICE.replace('$64,000.00', '$64,000.50'),
      QR_NOTICE.replace('$64,000.00', '$64 000'),
      QR_NOTICE.replace('Con codigo QR', 'Rechazado. Con codigo QR'),
      `${QR_NOTICE} El pago no se pudo procesar.`,
      `${QR_NOTICE} Saldo: $10.000`,
    ]) expect(parseMovementNotice(notice).success).toBe(false)
  })

  it('lee PSE en texto y HTML, conservando el CUS y sin inventar hora ni cuenta', () => {
    const html = `<table>${PSE_RECEIPT.split('\n').map((line) => `<tr><td>${line.split(': ')[0]}:</td><td>${line.split(': ')[1]}</td></tr>`).join('')}</table>`
    for (const notice of [PSE_RECEIPT, html]) {
      const result = parseMovementNotice(notice)
      expect(result.success).toBe(true)
      if (!result.success) continue
      expect(result.data).toMatchObject({ bank_name: 'PSE/ACH Colombia', notification_type: 'purchase', amount: 27500, occurred_on: '2026-11-07', occurred_time: null, provider_reference: '000123456', account_last_digits: null, card_last_digits: null, merchant: 'EMPRESA DE PRUEBA S.A.S.' })
    }
  })

  it('solo acepta estado aprobado inequívoco e importe entero válido de PSE', () => {
    for (const notice of [
      PSE_RECEIPT.replace('Aprobada', 'Rechazada'),
      PSE_RECEIPT.replace('Aprobada', 'Pendiente'),
      `${PSE_RECEIPT}\nEstado de la Transacción: Rechazada`,
      `${PSE_RECEIPT}\nResultado: Fallida`,
      PSE_RECEIPT.replace('27.500,00', '27.500,50'),
      PSE_RECEIPT.replace('27.500,00', '27.50,00'),
      PSE_RECEIPT.replace('CUS: 000123456', 'CUS: '),
    ]) expect(parsePseReceipt(notice).success).toBe(false)
  })
})

describe('parseBancolombiaNotification: textos incompletos y validaciones', () => {
  it('falla con texto vacío', () => {
    const result = parseBancolombiaNotification('')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('está vacío')
  })

  it('falla si no menciona a Bancolombia', () => {
    const result = parseBancolombiaNotification('Compraste $50.000 en Tienda el 10/10/2026 a las 10:00')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('No se reconoció un aviso de Bancolombia')
  })

  it('falla si no se reconoce el tipo de operación', () => {
    const result = parseBancolombiaNotification('Bancolombia: Saldo disponible $100.000 el 10/10/2026 a las 10:00')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('No pudimos identificar el tipo de aviso')
  })

  it('falla si falta el importe', () => {
    const result = parseBancolombiaNotification('Bancolombia: Compraste en Exito con tu T.Deb *1234 el 10/10/2026 a las 10:00')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('No pudimos encontrar el importe')
  })

  it('falla si falta la fecha u hora', () => {
    const result = parseBancolombiaNotification('Bancolombia: Compraste $50.000 en Exito con tu T.Deb *1234')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('No pudimos identificar la fecha y hora')
  })

  it('falla ante una fecha inválida en el calendario (ej. 31 de febrero)', () => {
    const result = parseBancolombiaNotification('Bancolombia: Compraste $50.000 en Exito con tu T.Deb *1234 el 31/02/2026 a las 10:00')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error).toContain('no corresponde a un día válido del calendario')
  })

  it('trata remitente con nombre no vacío adecuadamente', () => {
    const text = 'Bancolombia: Recibiste una transferencia por $50,000 de "Maria Gomez" en tu cuenta **8422, el 31/10/2026 a las 13:28.'
    const result = parseBancolombiaNotification(text)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.counterparty_name).toBe('Maria Gomez')
  })

  it('trata cuenta destino ajena con dígitos adecuadamente', () => {
    const text = 'Bancolombia: Transferiste $80,000 desde tu cuenta *8422 a la cuenta *5678 el 20/10/26 a las 21:15.'
    const result = parseBancolombiaNotification(text)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.counterparty_account_last_digits).toBe('5678')
  })

  it('no asume Apple Pay para compras con tarjeta de débito', () => {
    const text = 'Bancolombia: Compraste $39.900,00 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.'
    const result = parseBancolombiaNotification(text)
    expect(result.success).toBe(true)
    if (!result.success) return
    // Los campos no contienen ninguna mención ni inferencia a Apple Pay
    expect(JSON.stringify(result.data)).not.toContain('Apple Pay')
    expect(JSON.stringify(result.data)).not.toContain('apple_pay')
  })

  it('explica el problema y no crea pendiente si el aviso trae centavos distintos de cero', () => {
    const commaCents = parseBancolombiaNotification(
      'Bancolombia: Compraste $39.900,50 en HOMECENTER RIONEGRO con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    )
    expect(commaCents.success).toBe(false)
    if (!commaCents.success) {
      expect(commaCents.error).toMatch(/centavos distintos de cero/i)
      expect(commaCents.error).toMatch(/pesos enteros/i)
    }

    const dotCents = parseBancolombiaNotification(
      'Bancolombia: Transferiste $200,000.25 desde tu cuenta *8422 a la cuenta *"" el 20/10/26 a las 21:15.',
    )
    expect(dotCents.success).toBe(false)
    if (!dotCents.success) {
      expect(dotCents.error).toMatch(/centavos distintos de cero/i)
    }
  })

  it('rechaza separadores inválidos, espacios dentro del importe o múltiples importes ambiguos', () => {
    const badSeparators = parseBancolombiaNotification(
      'Bancolombia: Compraste $39.90,00 en Tienda con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    )
    expect(badSeparators.success).toBe(false)
    if (!badSeparators.success) {
      expect(badSeparators.error).toMatch(/separadores/i)
    }

    const splitDigits = parseBancolombiaNotification(
      'Bancolombia: Compraste $22 000 en Tienda con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    )
    expect(splitDigits.success).toBe(false)

    const multipleAmounts = parseBancolombiaNotification(
      'Bancolombia: Compraste $39.900,00 en Tienda (cupo restante $500.000,00) con tu T.Deb *0541, el 17/10/2026 a las 13:17.',
    )
    expect(multipleAmounts.success).toBe(false)
    if (!multipleAmounts.success) {
      expect(multipleAmounts.error).toMatch(/varios importes/i)
    }
  })
})

describe('validación estricta para «Ya lo registré» (compatibilidad y cuenta conocida)', () => {
  const accounts: FinancialAccount[] = [
    { id: 'acc-1', user_id: 'u-1', name: 'Ahorros 8422', account_type: 'bank', currency: 'COP', initial_balance: 0, archived_at: null, created_at: '', updated_at: '' },
    { id: 'acc-2', user_id: 'u-1', name: 'Corriente', account_type: 'bank', currency: 'COP', initial_balance: 0, archived_at: null, created_at: '', updated_at: '' },
    { id: 'acc-other', user_id: 'u-2', name: 'Ajena', account_type: 'bank', currency: 'COP', initial_balance: 0, archived_at: null, created_at: '', updated_at: '' },
  ]
  const links: BankCardAccountLink[] = [
    { id: 'l-1', user_id: 'u-1', identifier_type: 'card', last_digits: '0541', account_id: 'acc-1', created_at: '', updated_at: '' },
    { id: 'l-2', user_id: 'u-1', identifier_type: 'account', last_digits: '8422', account_id: 'acc-1', created_at: '', updated_at: '' },
    { id: 'l-other', user_id: 'u-2', identifier_type: 'card', last_digits: '0541', account_id: 'acc-other', created_at: '', updated_at: '' },
  ]

  function tx(overrides: Partial<FinancialTransaction>): FinancialTransaction {
    return {
      id: 'tx-1',
      user_id: 'u-1',
      kind: 'expense',
      account_id: 'acc-1',
      destination_account_id: null,
      amount: 39900,
      occurred_on: '2026-10-17',
      category_id: 'cat-1',
      description: 'Movimiento',
      client_request_id: 'req-1',
      deleted_at: null,
      created_at: '',
      updated_at: '',
      ...overrides,
    }
  }

  it('resuelve la cuenta conocida únicamente del propietario autenticado aunque otra persona tenga la misma terminación', () => {
    const notif: Pick<BankNotification, 'user_id' | 'card_last_digits' | 'account_last_digits'> = {
      user_id: 'u-1',
      card_last_digits: '0541',
      account_last_digits: null,
    }
    expect(resolveKnownAccountId(notif, links, accounts)).toBe('acc-1')
    expect(resolveKnownAccountId({ ...notif, user_id: 'u-2' }, links, accounts)).toBe('acc-other')
  })

  it('exige propietario, vigencia, importe exacto, tipo gasto y cuenta conocida en compras', () => {
    const purchase = { user_id: 'u-1', notification_type: 'purchase' as const, amount: 39900 }
    expect(isTransactionCompatibleWithNotification(tx({}), purchase, 'acc-1')).toBe(true)
    expect(isTransactionCompatibleWithNotification(tx({ user_id: 'u-2' }), purchase, 'acc-1')).toBe(false)
    expect(isTransactionCompatibleWithNotification(tx({ deleted_at: '2026-10-18T00:00:00Z' }), purchase, 'acc-1')).toBe(false)
    expect(isTransactionCompatibleWithNotification(tx({ amount: 39901 }), purchase, 'acc-1')).toBe(false)
    expect(isTransactionCompatibleWithNotification(tx({ kind: 'income' }), purchase, 'acc-1')).toBe(false)
    expect(isTransactionCompatibleWithNotification(tx({ kind: 'transfer', destination_account_id: 'acc-2' }), purchase, 'acc-1')).toBe(false)
    expect(isTransactionCompatibleWithNotification(tx({ account_id: 'acc-2' }), purchase, 'acc-1')).toBe(false)
  })

  it('en transferencias propias comprueba origen para salidas y destino para entradas', () => {
    const outgoing = { user_id: 'u-1', notification_type: 'transfer_sent' as const, amount: 200000 }
    const incoming = { user_id: 'u-1', notification_type: 'transfer_received' as const, amount: 22000 }

    // Salida desde acc-1: acepta gasto en acc-1 o transferencia con origen acc-1; rechaza transferencia donde acc-1 es destino
    expect(isTransactionCompatibleWithNotification(tx({ amount: 200000, kind: 'expense', account_id: 'acc-1' }), outgoing, 'acc-1')).toBe(true)
    expect(isTransactionCompatibleWithNotification(tx({ amount: 200000, kind: 'transfer', account_id: 'acc-1', destination_account_id: 'acc-2', category_id: null }), outgoing, 'acc-1')).toBe(true)
    expect(isTransactionCompatibleWithNotification(tx({ amount: 200000, kind: 'transfer', account_id: 'acc-2', destination_account_id: 'acc-1', category_id: null }), outgoing, 'acc-1')).toBe(false)

    // Entrada hacia acc-1: acepta ingreso en acc-1 o transferencia con destino acc-1; rechaza transferencia donde acc-1 es origen
    expect(isTransactionCompatibleWithNotification(tx({ amount: 22000, kind: 'income', account_id: 'acc-1' }), incoming, 'acc-1')).toBe(true)
    expect(isTransactionCompatibleWithNotification(tx({ amount: 22000, kind: 'transfer', account_id: 'acc-2', destination_account_id: 'acc-1', category_id: null }), incoming, 'acc-1')).toBe(true)
    expect(isTransactionCompatibleWithNotification(tx({ amount: 22000, kind: 'transfer', account_id: 'acc-1', destination_account_id: 'acc-2', category_id: null }), incoming, 'acc-1')).toBe(false)
  })
})
