import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const relative = 'supabase/functions/.env.google-key'
const target = resolve(root, relative)
execFileSync('git', ['check-ignore', '--quiet', relative], { cwd: root, stdio: 'ignore' })
if (existsSync(target)) throw new Error('La clave local de Google ya existe. No se reemplazó.')
writeFileSync(target, `GOOGLE_CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
console.log('Clave creada en supabase/functions/.env.google-key (ignorado). No regeneres una clave en uso.')
