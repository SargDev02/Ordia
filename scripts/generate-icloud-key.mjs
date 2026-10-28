import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../supabase/functions/.env.icloud')
if (existsSync(target)) throw new Error('La clave local de iCloud ya existe. No se reemplazó.')
writeFileSync(target, `ICLOUD_CREDENTIAL_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
console.log('Clave creada en supabase/functions/.env.icloud (ignorado). No compartas ese archivo ni regeneres una clave en uso.')
