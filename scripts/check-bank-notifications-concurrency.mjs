// Prueba real de concurrencia en PostgreSQL local para «Movimientos por revisar».
// Usa dos conexiones PostgreSQL independientes con rol 'authenticated' y barrera observada en pg_blocking_pids.
// Seguridad: rechaza conectarse a cualquier host distinto de localhost / 127.0.0.1 / ::1 (nunca usa producción).
import postgres from 'postgres'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

function resolveLocalDbUrl() {
  if (process.env.LOCAL_DATABASE_URL) return process.env.LOCAL_DATABASE_URL
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const supabaseEntry = resolve(root, 'node_modules/supabase/dist/supabase.js')
  const probe = spawnSync(process.execPath, [supabaseEntry, 'status', '-o', 'json'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (probe.status !== 0) {
    throw new Error(`No se pudo descubrir DB_URL desde supabase status: ${probe.stderr || probe.stdout}`)
  }
  const jsonStart = probe.stdout.indexOf('{')
  assert.ok(jsonStart >= 0, 'supabase status -o json no devolvió JSON válido')
  const parsedStatus = JSON.parse(probe.stdout.slice(jsonStart))
  assert.ok(parsedStatus.DB_URL, 'supabase status no incluyó DB_URL')
  return parsedStatus.DB_URL
}

const dbUrl = resolveLocalDbUrl()
const parsedUrl = new URL(dbUrl)
const allowedLocalHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

if (
  !allowedLocalHosts.has(parsedUrl.hostname) ||
  dbUrl.includes('dedtyhomynsmvatfnshs') ||
  /supabase\.(co|com)$/i.test(parsedUrl.hostname)
) {
  throw new Error(
    `Este script solo puede ejecutarse contra PostgreSQL local de pruebas. Host rechazado: ${parsedUrl.hostname}`,
  )
}

const options = {
  max: 1,
  prepare: false,
  connect_timeout: 5,
  idle_timeout: 0,
  onnotice: () => undefined,
}

const admin = postgres(dbUrl, options)
const firstClient = postgres(dbUrl, options)
const secondClient = postgres(dbUrl, options)

const uid = randomUUID()
const email = `bank-inbox-race-${uid}@ordia.test`
const gate = () => {
  let resolveGate
  const promise = new Promise((done) => {
    resolveGate = done
  })
  return { promise, resolve: resolveGate }
}

async function identity(tx) {
  await tx`set local role authenticated`
  await tx`select set_config('request.jwt.claim.sub', ${uid}, true)`
  await tx`set local statement_timeout = '20s'`
  await tx`set local lock_timeout = '15s'`
}

let created = false
let phase = 'connect'
const scenarios = []

try {
  phase = 'setup'
  const setup = await admin.begin(async (tx) => {
    await tx`insert into auth.users (id, email) values (${uid}, ${email})`
    await identity(tx)

    const acc1 = randomUUID()
    const acc2 = randomUUID()
    const catExpense = randomUUID()
    const catArchived = randomUUID()

    await tx`
      insert into public.financial_accounts (id, user_id, name, account_type, currency, initial_balance)
      values
        (${acc1}, ${uid}, 'Cuenta Ahorros Local', 'bank', 'COP', 1000000),
        (${acc2}, ${uid}, 'Cuenta Corriente Local', 'bank', 'COP', 500000)
    `
    await tx`
      insert into public.financial_categories (id, user_id, kind, name, archived_at)
      values
        (${catExpense}, ${uid}, 'expense', 'Compras Local', null),
        (${catArchived}, ${uid}, 'expense', 'Archivada Local', null)
    `
    await tx`
      update public.financial_categories
      set archived_at = now()
      where id = ${catArchived}
    `

    const [createdNotif] = await tx`
      select (public.create_bank_notification(
        ${randomUUID()}, 'Bancolombia', 'manual', 'purchase', 39900,
        '2026-10-17'::date, '13:17', 'HOMECENTER RIONEGRO', null, '0541', 'debit', null, null
      )).id as notification_id
    `

    const [createdTransferNotif] = await tx`
      select (public.create_bank_notification(
        ${randomUUID()}, 'Bancolombia', 'manual', 'transfer_sent', 200000,
        '2026-10-20'::date, '21:15', null, '8422', null, null, null, null
      )).id as notification_id
    `

    const existingTxId = randomUUID()
    await tx`
      insert into public.financial_transactions (
        id, user_id, client_request_id, kind, account_id, destination_account_id,
        amount, occurred_on, category_id, description
      ) values (
        ${existingTxId}, ${uid}, ${randomUUID()}, 'expense', ${acc1}, null,
        200000, '2026-10-20'::date, ${catExpense}, 'Gasto manual previo'
      )
    `

    return {
      acc1,
      acc2,
      catExpense,
      catArchived,
      purchaseNotifId: createdNotif.notification_id,
      transferNotifId: createdTransferNotif.notification_id,
      existingTxId,
    }
  })
  created = true

  // Escenario 1: Fallo al crear el movimiento deja el aviso en 'pending' y sin efecto en saldo
  phase = 'failed-movement-keeps-pending'
  await assert.rejects(
    () =>
      firstClient.begin(async (tx) => {
        await identity(tx)
        await tx`
          select public.confirm_bank_notification_as_transaction(
            ${setup.purchaseNotifId}, ${randomUUID()}, 'expense',
            ${setup.acc1}, ${setup.catArchived}, 'Fallo esperado categoría archivada', '2026-10-17'::date, false, null, null
          )
        `
      }),
    (err) => err.code === '23503',
  )

  await assert.rejects(
    () =>
      firstClient.begin(async (tx) => {
        await identity(tx)
        await tx`
          select public.confirm_bank_notification_as_transaction(
            ${setup.purchaseNotifId}, ${randomUUID()}, 'expense',
            ${setup.acc1}, ${setup.catExpense}, ${'x'.repeat(241)}, '2026-10-17'::date, false, null, null
          )
        `
      }),
    (err) => err.code === '23514',
  )

  const [afterFailedAttempt] = await admin`
    select
      n.status,
      n.resolved_transaction_id,
      (select initial_balance - coalesce(sum(case when kind = 'expense' and deleted_at is null then amount else 0 end), 0)
       from public.financial_accounts a
       left join public.financial_transactions t on t.account_id = a.id
       where a.id = ${setup.acc1}
       group by a.initial_balance)::bigint as acc1_balance
    from public.bank_notifications n
    where n.id = ${setup.purchaseNotifId}
  `
  assert.equal(afterFailedAttempt.status, 'pending')
  assert.equal(afterFailedAttempt.resolved_transaction_id, null)
  assert.equal(Number(afterFailedAttempt.acc1_balance), 1000000 - 200000, 'El saldo no debe cambiar tras un fallo')
  scenarios.push({
    scenario: phase,
    status_after_fail: afterFailedAttempt.status,
    balance_unchanged: Number(afterFailedAttempt.acc1_balance) === 800000,
  })

  // Escenario 2: Dos conexiones independientes confirman simultáneamente el mismo pendiente con request_id distintos
  phase = 'concurrent-confirm-same-pending'
  {
    const reqA = randomUUID()
    const reqB = randomUUID()
    const aReady = gate()
    const bReady = gate()
    const release = gate()
    let aInfo
    let bInfo
    let observedBlocking = false
    let secondSettled = false
    let barrierError

    const first = firstClient.begin('isolation level read committed', async (tx) => {
      await identity(tx)
      ;[aInfo] = await tx`select pg_backend_pid() as pid, current_user as role`
      const [row] = await tx`
        select (public.confirm_bank_notification_as_transaction(
          ${setup.purchaseNotifId}, ${reqA}, 'expense',
          ${setup.acc1}, ${setup.catExpense}, 'Compra ganadora A', '2026-10-17'::date, true, 'card', '0541'
        )).id as tx_id
      `
      aInfo.txId = row.tx_id
      aReady.resolve()
      await release.promise
    })
    void first.catch(() => aReady.resolve())
    await aReady.promise
    if (!aInfo?.txId) {
      await first
      throw new Error('La conexión A no alcanzó a bloquear y resolver el pendiente.')
    }

    const second = secondClient.begin('isolation level read committed', async (tx) => {
      await identity(tx)
      ;[bInfo] = await tx`select pg_backend_pid() as pid, current_user as role`
      bReady.resolve()
      const started = performance.now()
      try {
        await tx`
          select public.confirm_bank_notification_as_transaction(
            ${setup.purchaseNotifId}, ${reqB}, 'expense',
            ${setup.acc2}, ${setup.catExpense}, 'Compra perdedora B', '2026-10-17'::date, false, null, null
          )
        `
      } catch (error) {
        bInfo.waited_ms = Math.round(performance.now() - started)
        throw error
      }
    })
    void second.then(
      () => {
        secondSettled = true
        bReady.resolve()
      },
      () => {
        secondSettled = true
        bReady.resolve()
      },
    )

    try {
      await bReady.promise
      assert.ok(bInfo, 'La conexión B no abrió su transacción')
      assert.notEqual(aInfo.pid, bInfo.pid, 'Las dos conexiones deben tener PIDs distintos')

      const deadline = Date.now() + 8000
      while (Date.now() < deadline && !secondSettled) {
        const [lockState] = await admin`
          select ${aInfo.pid}::integer = any(pg_blocking_pids(${bInfo.pid})) as blocked
        `
        if (lockState.blocked) {
          observedBlocking = true
          break
        }
        await new Promise((done) => setTimeout(done, 25))
      }
      assert.ok(observedBlocking, 'No se observó a la conexión B esperando el FOR UPDATE de A')
      await new Promise((done) => setTimeout(done, 200))
    } catch (error) {
      barrierError = error
    } finally {
      release.resolve()
    }

    const outcomes = await Promise.allSettled([first, second])
    if (barrierError) throw barrierError
    assert.equal(outcomes[0].status, 'fulfilled', 'La conexión A debía confirmar')
    assert.equal(outcomes[1].status, 'rejected', 'La conexión B debía fallar con conflicto')
    assert.equal(outcomes[1].reason.code, '23505')

    const [verification] = await admin`
      select
        (select count(*)::integer from public.financial_transactions where user_id = ${uid} and amount = 39900 and deleted_at is null) as created_tx_count,
        (select initial_balance - coalesce(sum(case when kind = 'expense' and deleted_at is null then amount else 0 end), 0)
         from public.financial_accounts a
         left join public.financial_transactions t on t.account_id = a.id
         where a.id = ${setup.acc1}
         group by a.initial_balance)::bigint as acc1_balance,
        n.status,
        n.resolved_transaction_id,
        n.resolution_request_id
      from public.bank_notifications n
      where n.id = ${setup.purchaseNotifId}
    `

    assert.equal(verification.created_tx_count, 1, 'Debe existir exactamente un movimiento de $39.900')
    assert.equal(Number(verification.acc1_balance), 1000000 - 200000 - 39900, 'Efecto único en saldo')
    assert.equal(verification.status, 'resolved')
    assert.equal(verification.resolved_transaction_id, aInfo.txId, 'La resolución ganadora no debe sobrescribirse')
    assert.equal(verification.resolution_request_id, reqA)

    scenarios.push({
      scenario: phase,
      a_pid: aInfo.pid,
      b_pid: bInfo.pid,
      blocked_before_commit: observedBlocking,
      waited_ms: bInfo.waited_ms,
      loser_sqlstate: outcomes[1].reason.code,
      created_tx_count: verification.created_tx_count,
    })
  }

  // Escenario 3: Carrera entre confirmar transferencia (A) y «Ya lo registré» (B) sobre el mismo aviso
  phase = 'concurrent-transfer-vs-link'
  {
    const reqTransfer = randomUUID()
    const aReady = gate()
    const bReady = gate()
    const release = gate()
    let aInfo
    let bInfo
    let observedBlocking = false
    let secondSettled = false
    let barrierError

    const first = firstClient.begin('isolation level read committed', async (tx) => {
      await identity(tx)
      ;[aInfo] = await tx`select pg_backend_pid() as pid`
      const [row] = await tx`
        select (public.confirm_bank_notification_as_transfer(
          ${setup.transferNotifId}, ${reqTransfer},
          ${setup.acc1}, ${setup.acc2}, 'Transferencia propia ganadora', '2026-10-20'::date, false, null, null
        )).id as tx_id
      `
      aInfo.txId = row.tx_id
      aReady.resolve()
      await release.promise
    })
    void first.catch(() => aReady.resolve())
    await aReady.promise
    if (!aInfo?.txId) {
      await first
      throw new Error('La conexión A no resolvió la transferencia.')
    }

    const second = secondClient.begin('isolation level read committed', async (tx) => {
      await identity(tx)
      ;[bInfo] = await tx`select pg_backend_pid() as pid`
      bReady.resolve()
      await tx`select public.link_bank_notification_to_transaction(${setup.transferNotifId}, ${setup.existingTxId})`
    })
    void second.then(
      () => {
        secondSettled = true
        bReady.resolve()
      },
      () => {
        secondSettled = true
        bReady.resolve()
      },
    )

    try {
      await bReady.promise
      assert.notEqual(aInfo.pid, bInfo.pid)
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && !secondSettled) {
        const [lockState] = await admin`
          select ${aInfo.pid}::integer = any(pg_blocking_pids(${bInfo.pid})) as blocked
        `
        if (lockState.blocked) {
          observedBlocking = true
          break
        }
        await new Promise((done) => setTimeout(done, 25))
      }
      assert.ok(observedBlocking, 'B no fue observado bloqueado por A en carrera transferencia vs vínculo')
    } catch (error) {
      barrierError = error
    } finally {
      release.resolve()
    }

    const outcomes = await Promise.allSettled([first, second])
    if (barrierError) throw barrierError
    assert.equal(outcomes[0].status, 'fulfilled')
    assert.equal(outcomes[1].status, 'rejected')
    assert.equal(outcomes[1].reason.code, '23505')

    const [notifAfter] = await admin`
      select status, resolved_transaction_id, resolution_request_id
      from public.bank_notifications
      where id = ${setup.transferNotifId}
    `
    assert.equal(notifAfter.status, 'resolved')
    assert.equal(notifAfter.resolved_transaction_id, aInfo.txId)
    assert.equal(notifAfter.resolution_request_id, reqTransfer)

    scenarios.push({
      scenario: phase,
      a_pid: aInfo.pid,
      b_pid: bInfo.pid,
      blocked_before_commit: observedBlocking,
      loser_sqlstate: outcomes[1].reason.code,
    })
  }

  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        host: parsedUrl.hostname,
        port: Number(parsedUrl.port || 5432),
        scenarios,
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error(
    JSON.stringify({
      result: 'FAIL',
      phase,
      code: error.code ?? 'assertion',
      message: error.message,
    }),
  )
  process.exitCode = 1
} finally {
  try {
    if (created) {
      await admin`delete from auth.users where id = ${uid} and email = ${email}`
      const [remaining] = await admin`
        select
          (select count(*)::integer from auth.users where id = ${uid}) as users,
          (select count(*)::integer from public.bank_notifications where user_id = ${uid}) as notifications,
          (select count(*)::integer from public.bank_card_account_links where user_id = ${uid}) as card_links,
          (select count(*)::integer from public.financial_accounts where user_id = ${uid}) as accounts,
          (select count(*)::integer from public.financial_categories where user_id = ${uid}) as categories,
          (select count(*)::integer from public.financial_transactions where user_id = ${uid}) as transactions
      `
      assert.deepEqual(
        { ...remaining },
        { users: 0, notifications: 0, card_links: 0, accounts: 0, categories: 0, transactions: 0 },
      )
      console.log(JSON.stringify({ cleanup: remaining }))
    }
  } finally {
    await Promise.all([admin.end({ timeout: 5 }), firstClient.end({ timeout: 5 }), secondClient.end({ timeout: 5 })])
  }
}
