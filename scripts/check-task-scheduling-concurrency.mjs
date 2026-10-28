// Prueba real: clientes PostgreSQL independientes, barrera controlada por pg_blocking_pids.
// No usa service_role para programar ni equivale a sesiones Supabase Auth/JWT normales.
import postgres from 'postgres'
import { spawn } from 'node:child_process'
import { randomUUID, X509Certificate } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ref = 'dedtyhomynsmvatfnshs'
const cli = resolve(root, 'node_modules/supabase/dist/supabase.js')
const uid = randomUUID(); const email = `planner-race-${uid}@ordia.test`
const folder = resolve(root, 'tmp', `planner-race-${uid}`)
await mkdir(folder, { recursive: true })
assert.equal((await readFile(resolve(root, 'supabase/.temp/project-ref'), 'utf8')).trim(), ref)
async function command(args) {
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.resume() // No imprimir salida de configuración que pudiera contener secretos.
  const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done) })
  assert.equal(code, 0, 'No se pudo preparar el acceso CLI a Ordia')
  return stdout
}
const projects = JSON.parse(await command(['projects', 'list', '--output', 'json']))
assert.equal(projects.find((project) => (project.id ?? project.ref) === ref)?.name, 'Ordia')
// dry-run solo obtiene el script; nunca se ejecuta pg_dump ni se imprime la contraseña temporal.
const script = await command(['db', 'dump', '--linked', '--project-ref', ref, '--dry-run'])
const connection = {}
for (const line of script.split(/\r?\n/)) {
  const match = /^export (PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE)=(.*)$/.exec(line)
  if (!match) continue
  let value = match[2].trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  connection[match[1]] = value
}
assert.ok(connection.PGPASSWORD && connection.PGHOST && connection.PGUSER)
assert.ok(connection.PGHOST === `db.${ref}.supabase.co` || (/\.pooler\.supabase\.com$/.test(connection.PGHOST) && connection.PGUSER.endsWith(`.${ref}`)), 'Destino PostgreSQL distinto de Ordia')
// Misma URL de certificado publicada por Supabase Studio (ssl:certificate_url).
const caResponse = await fetch('https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt')
assert.ok(caResponse.ok, 'No se pudo obtener la CA oficial de Supabase')
const ca = await caResponse.text()
assert.equal(new X509Certificate(ca).ca, true, 'El certificado descargado no es una CA')
const options = { host: connection.PGHOST, port: Number(connection.PGPORT), username: connection.PGUSER,
  password: connection.PGPASSWORD, database: connection.PGDATABASE, ssl: { rejectUnauthorized: true, ca },
  max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0, onnotice: () => undefined }
const admin = postgres(options); const firstClient = postgres(options); const secondClient = postgres(options)
const results = []
const gate = () => { let resolveGate; const promise = new Promise((done) => { resolveGate = done }); return { promise, resolve: resolveGate } }
async function identity(tx) {
  await tx`set local role authenticated`
  await tx`select set_config('request.jwt.claim.sub',${uid},true)`
  await tx`set local statement_timeout='25s'`
  await tx`set local lock_timeout='20s'`
}
async function program(tx, mode, id, time) {
  if (mode === 'rpc') {
    await tx`select public.schedule_personal_task(${id},${time},(select updated_at from public.personal_tasks where id=${id}),60,true)`
  } else await tx`update public.personal_tasks set scheduled_at=${time},estimated_minutes=60 where id=${id}`
}
let created = false
let cleanup = null
let phase = 'prepare_role'
try {
  // El login temporal de la CLI no hereda permisos: igual que la CLI, selecciona postgres.
  await Promise.all([admin`set role postgres`, firstClient`set role postgres`, secondClient`set role postgres`])
  phase = 'setup'
  const setup = await admin.begin(async (tx) => {
    assert.equal((await tx`select count(*)::integer as n from auth.users where id=${uid}`)[0].n, 0)
    await tx`insert into auth.users(id,email) values(${uid},${email})`
    await identity(tx)
    await tx`insert into public.task_scheduling_preferences(buffer_minutes,slots) values(15,
      (select jsonb_agg(jsonb_build_object('day_of_week',d,'start_time','09:00','end_time','18:00')) from generate_series(1,7) d))`
    const tasks = await tx`select (public.create_personal_task(${randomUUID()},'Fixture carrera A',null,'medium',60,null,null)).id as first,
      (public.create_personal_task(${randomUUID()},'Fixture carrera B',null,'medium',60,null,null)).id as second`
    const time = await tx`select ((((now() at time zone 'America/Bogota')::date+2)::text||' 10:00:00-05')::timestamptz) as starts`
    return { ...tasks[0], starts: time[0].starts }
  })
  created = true
  for (const [firstMode, secondMode, minutes] of [['rpc','rpc',30],['rpc','manual',30],['manual','rpc',30],['rpc','rpc',70]]) {
    phase = `${firstMode}-${secondMode}-${minutes}`
    await admin.begin(async (tx) => { await identity(tx); await tx`update public.personal_tasks set scheduled_at=null where id in (${setup.first},${setup.second})` })
    const aReady = gate(); const bReady = gate(); const release = gate()
    let aInfo; let bInfo; let observed = false; let secondSettled = false; let barrierError
    const first = firstClient.begin('isolation level read committed', async (tx) => {
      await identity(tx)
      aInfo = (await tx`select pg_backend_pid() as pid,current_user as role,auth.uid()=${uid}::uuid as same_user,current_setting('transaction_isolation') as isolation`)[0]
      await program(tx, firstMode, setup.first, setup.starts)
      aReady.resolve(); await release.promise
    })
    void first.catch(() => aReady.resolve())
    await aReady.promise
    if (!aInfo) { await first; throw new Error('A no inició su programación') }
    // Si la escritura de A falló, no iniciar B ni dejar promesas pendientes.
    if ((await admin`select exists(select 1 from pg_locks where pid=${aInfo.pid} and locktype='advisory' and granted) as locked`)[0].locked !== true) {
      release.resolve(); await first; throw new Error('A no conservó su candado tras programar')
    }
    const second = secondClient.begin('isolation level read committed', async (tx) => {
      await identity(tx)
      bInfo = (await tx`select pg_backend_pid() as pid,current_user as role,auth.uid()=${uid}::uuid as same_user`)[0]
      bReady.resolve()
      const started = performance.now()
      try { await program(tx, secondMode, setup.second, new Date(setup.starts.getTime()+minutes*60000)) }
      catch (error) { bInfo.waited_ms = Math.round(performance.now()-started); throw error }
    })
    void second.then(() => { secondSettled = true; bReady.resolve() }, () => { secondSettled = true; bReady.resolve() })
    try {
      await bReady.promise
      assert.ok(bInfo, 'B no abrió su transacción')
      assert.notEqual(aInfo.pid, bInfo.pid, 'Las conexiones no son independientes')
      const deadline = Date.now()+10000
      while (Date.now()<deadline && !secondSettled) {
        const locks = await admin`select ${aInfo.pid}::integer=any(pg_blocking_pids(${bInfo.pid})) as blocked,
          exists(select 1 from pg_locks where pid=${bInfo.pid} and locktype='advisory' and not granted) as advisory_wait`
        if (locks[0].blocked && locks[0].advisory_wait) { observed = true; break }
        await new Promise((done) => setTimeout(done, 25))
      }
      assert.ok(observed, 'B no fue observado esperando el candado de A antes del commit')
      // Otra conexión no ve la escritura de A todavía: no hay lectura sucia.
      assert.equal((await admin`select scheduled_at is null as invisible from public.personal_tasks where id=${setup.first}`)[0].invisible, true)
      await new Promise((done) => setTimeout(done, 250))
    } catch (error) { barrierError = error }
    finally { release.resolve() }
    const outcomes = await Promise.allSettled([first,second])
    if (barrierError) throw barrierError
    assert.equal(outcomes[0].status, 'fulfilled', 'A no confirmó')
    assert.equal(outcomes[1].status, 'rejected', 'B aceptó una programación incompatible')
    assert.equal(outcomes[1].reason.code, '23P01'); assert.equal(outcomes[1].reason.message, 'task_schedule_overlap')
    assert.ok(bInfo.waited_ms>=200)
    assert.equal(aInfo.role, 'authenticated'); assert.equal(bInfo.role, 'authenticated')
    assert.equal(aInfo.same_user, true); assert.equal(bInfo.same_user, true)
    const final = await admin`select count(*) filter(where scheduled_at is not null)::integer as scheduled,
      count(*) filter(where id=${setup.first} and scheduled_at is not null)::integer as winner,
      count(*) filter(where id=${setup.second} and scheduled_at is null)::integer as loser_unchanged
      from public.personal_tasks where user_id=${uid}`
    assert.deepEqual({ ...final[0] }, { scheduled: 1, winner: 1, loser_unchanged: 1 })
    results.push({ scenario: `${firstMode}-${secondMode}-${minutes}`, a_pid: aInfo.pid, b_pid: bInfo.pid, same_user: true,
      role: aInfo.role, isolation: aInfo.isolation, blocked_before_commit: observed, waited_ms: bInfo.waited_ms,
      loser_sqlstate: outcomes[1].reason.code, ...final[0] })
    console.log(JSON.stringify(results.at(-1)))
  }
} catch (error) {
  // No propagar objetos de conexión ni opciones/contraseñas en errores de red.
  console.error(JSON.stringify({ result: 'FAIL', phase, code: error.code ?? 'assertion', message: error.code ? 'Falló conexión o consulta; revisar código y entorno.' : error.message }))
  process.exitCode = 1
} finally {
  try {
    if (created) {
      await admin`delete from auth.users where id=${uid} and email=${email}`
      const remaining = (await admin`select (select count(*) from auth.users where id=${uid})::integer as users,
        (select count(*) from public.personal_tasks where user_id=${uid})::integer as tasks,
        (select count(*) from public.task_scheduling_preferences where user_id=${uid})::integer as preferences`)[0]
      assert.deepEqual({ ...remaining }, { users: 0, tasks: 0, preferences: 0 })
      cleanup = { ...remaining }
      console.log(JSON.stringify({ cleanup: remaining }))
    }
  } catch {
    process.exitCode = 1
    console.error(JSON.stringify({ result: 'FAIL', phase: 'cleanup', fixture_user: uid, message: 'No se pudo comprobar la limpieza exclusiva del fixture.' }))
  } finally { await Promise.all([admin.end({timeout:5}),firstClient.end({timeout:5}),secondClient.end({timeout:5})]) }
}
await writeFile(resolve(folder,'result.json'),JSON.stringify({ project: ref, result: process.exitCode ? 'FAIL' : 'PASS', scenarios: results, cleanup },null,2))
if (!process.exitCode) console.log(`PASS: ${results.length} carreras entre conexiones PostgreSQL independientes con barrera observada.`)
