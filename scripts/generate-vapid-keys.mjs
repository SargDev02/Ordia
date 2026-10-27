import { createECDH, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const browserEnvPath = resolve(projectRoot, '.env.local')
const functionEnvPath = resolve(projectRoot, 'supabase/functions/.env.push')
const vaultSqlPath = resolve(projectRoot, 'supabase/setup_push_vault.local.sql')
const projectUrl = 'https://dedtyhomynsmvatfnshs.supabase.co'

if (existsSync(functionEnvPath) || existsSync(vaultSqlPath)) {
  throw new Error('Ya existe configuración push local. No se reemplazó ningún secreto.')
}

const browserEnv = existsSync(browserEnvPath) ? readFileSync(browserEnvPath, 'utf8') : ''
const existingPublicKey = browserEnv.match(/^VITE_VAPID_PUBLIC_KEY=(.+)$/m)?.[1]?.trim()
if (existingPublicKey) {
  throw new Error('VITE_VAPID_PUBLIC_KEY ya tiene un valor. No se reemplazó la configuración.')
}

const vapid = createECDH('prime256v1')
vapid.generateKeys()
const publicKey = vapid.getPublicKey().toString('base64url')
const privateKey = vapid.getPrivateKey().toString('base64url')
const cronSecret = randomBytes(48).toString('base64url')

const nextBrowserEnv = setEnvValue(browserEnv, 'VITE_VAPID_PUBLIC_KEY', publicKey)
writeFileSync(browserEnvPath, nextBrowserEnv, { encoding: 'utf8', mode: 0o600 })
writeFileSync(functionEnvPath, [
  `VAPID_PUBLIC_KEY=${publicKey}`,
  `VAPID_PRIVATE_KEY=${privateKey}`,
  `VAPID_SUBJECT=${projectUrl}`,
  `PUSH_CRON_SECRET=${cronSecret}`,
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 })
writeFileSync(vaultSqlPath, [
  '-- Archivo local ignorado. Contiene un secreto: no lo compartas ni lo agregues a Git.',
  `select vault.create_secret('${projectUrl}', 'ordia_project_url', 'URL del proyecto Ordia para el job push')`,
  "where not exists (select 1 from vault.secrets where name = 'ordia_project_url');",
  `select vault.create_secret('${cronSecret}', 'ordia_push_cron_secret', 'Secreto del job push de Ordia')`,
  "where not exists (select 1 from vault.secrets where name = 'ordia_push_cron_secret');",
  '',
].join('\n'), { encoding: 'utf8', mode: 0o600 })

console.log('Configuración push generada en archivos locales ignorados; no se mostraron claves.')

function setEnvValue(contents, name, value) {
  const line = `${name}=${value}`
  if (new RegExp(`^${name}=.*$`, 'm').test(contents)) {
    return contents.replace(new RegExp(`^${name}=.*$`, 'm'), line)
  }
  const separator = contents.length === 0 || contents.endsWith('\n') ? '' : '\n'
  return `${contents}${separator}${line}\n`
}
