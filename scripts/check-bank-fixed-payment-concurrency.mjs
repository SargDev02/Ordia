// Solo PostgreSQL local desechable. Dos conexiones autenticadas, datos sintéticos.
import postgres from 'postgres'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const address = process.env.ORDIA_LOCAL_TEST_DB_URL
assert.ok(address, 'Define ORDIA_LOCAL_TEST_DB_URL con una base local desechable')
const url = new URL(address)
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Se rechaza cualquier servidor remoto')
assert.ok(/(test|local|improvements)/i.test(url.pathname), 'La base debe identificarse como local o de pruebas')
const config = { max: 1, onnotice: () => {} }
const admin = postgres(address, config), a = postgres(address, config), b = postgres(address, config)
const uid = randomUUID()
try {
  await admin`insert into auth.users(id,email) values(${uid},${`race-${uid}@ordia.test`})`
  for (const sameRequest of [true, false]) {
    const setup = await admin.begin(async (sql) => {
      await sql`set local role authenticated`
      await sql`select set_config('request.jwt.claim.sub',${uid},true)`
      const [account] = await sql`insert into public.financial_accounts(name,account_type,initial_balance) values('Banco de prueba','bank',50000) returning id`
      const [category] = await sql`insert into public.financial_categories(name,kind) values(${`Categoría ${randomUUID()}`},'expense') returning id`
      const [expense] = await sql`select (public.create_fixed_expense(${randomUUID()},'Pago de prueba',5000,${category.id},${account.id},'monthly',(now() at time zone 'America/Bogota')::date,null)).id`
      const [period] = await sql`select id from public.fixed_expense_periods where fixed_expense_id=${expense.id} order by due_date limit 1`
      const [notice] = await sql`select (public.create_movement_notice(${randomUUID()},'Bancolombia','manual','purchase',3000,(now() at time zone 'America/Bogota')::date,'10:00',null,null,null,null,null,null,null,null,null)).id`
      return { account: account.id, category: category.id, period: period.id, notice: notice.id }
    })
    const request = randomUUID()
    let release, entered
    const hold = new Promise(resolve => { release = resolve })
    const ready = new Promise(resolve => { entered = resolve })
    const pay = (sql, key) => sql`select (public.pay_fixed_expense_from_bank_notice(${setup.notice},${setup.period},${key},${setup.account},${setup.category},(now() at time zone 'America/Bogota')::date,3000)).id`
    const first = a.begin(async sql => {
      await sql`set local role authenticated`; await sql`select set_config('request.jwt.claim.sub',${uid},true)`
      const result = await pay(sql, request); entered(); await hold; return result
    })
    await Promise.race([ready, first.then(() => { throw new Error('La primera sesión terminó sin barrera') })])
    let secondPid
    const second = b.begin(async sql => {
      await sql`set local role authenticated`; await sql`select set_config('request.jwt.claim.sub',${uid},true)`
      secondPid = (await sql`select pg_backend_pid() as pid`)[0].pid
      return pay(sql, sameRequest ? request : randomUUID())
    })
    // Adjuntar el manejador antes de liberar para no dejar rechazos sin manejar.
    const results = Promise.allSettled([first, second])
    let blocked = false
    try {
      for (let index = 0; index < 100; index++) {
        if (secondPid && (await admin`select cardinality(pg_blocking_pids(${secondPid}))>0 as blocked`)[0].blocked) { blocked = true; break }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    } finally { release() }
    const outcome = await results
    assert.ok(blocked, 'La segunda sesión debía esperar el bloqueo de la primera')
    assert.equal(outcome[0].status, 'fulfilled')
    if (sameRequest) {
      assert.equal(outcome[1].status, 'fulfilled'); assert.equal(outcome[0].value[0].id, outcome[1].value[0].id)
    } else { assert.equal(outcome[1].status, 'rejected'); assert.equal(outcome[1].reason.code, '23505') }
    const [count] = await admin`select count(*)::integer as total from public.financial_transactions where account_id=${setup.account} and deleted_at is null`
    assert.equal(count.total, 1)
    console.log(`PASS: dos sesiones, ${sameRequest ? 'mismo request idempotente' : 'solicitudes distintas sin doble pago'}, bloqueo observado`)
  }
} finally {
  // Solo el usuario sintético de esta ejecución, en el servidor local validado arriba.
  try {
    for (const table of ['bank_notifications','fixed_expense_periods','fixed_expense_versions','fixed_expenses','financial_transactions','financial_accounts','financial_categories']) {
      await admin`delete from ${admin(table)} where user_id=${uid}`
    }
    await admin`delete from auth.users where id=${uid}`
  } finally { await Promise.all([admin.end({ timeout: 5 }), a.end({ timeout: 5 }), b.end({ timeout: 5 })]) }
}
