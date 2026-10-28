import { useRef, useState, type FormEvent } from 'react'
import { FormDialog } from './FormDialog'
import { FormField } from './FormField'
import { AuthNotice } from './AuthNotice'

export function IcloudConnectDialog({ onClose, onConnect }: { onClose: () => void; onConnect: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('')
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const pending = useRef(false)
  function close() {
    if (pending.current || (dirty && !window.confirm('¿Descartar los datos de conexión sin guardar?'))) return
    setPassword(''); onClose()
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (pending.current) return
    setError('')
    if (!window.isSecureContext) return setError('Abre Ordia mediante HTTPS o localhost antes de introducir credenciales.')
    if (!/^[a-z]{4}(?:-[a-z]{4}){3}$/i.test(password)) return setError('Usa una contraseña específica de aplicación con formato abcd-efgh-ijkl-mnop. Nunca uses tu contraseña principal.')
    pending.current = true; setBusy(true)
    try { await onConnect(email.trim(), password); setPassword(''); onClose() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos validar la conexión.') }
    finally { pending.current = false; setBusy(false) }
  }
  return <FormDialog title="Conectar iCloud" onClose={close}><form className="p-6 sm:p-8" aria-busy={busy} onSubmit={submit} onChange={() => setDirty(true)}>
    <div className="flex items-start justify-between gap-3"><h2 className="text-2xl font-semibold text-[#173f31]">Conectar iCloud</h2><button className="min-h-11 px-2 font-semibold text-[#52675d]" disabled={busy} onClick={close} type="button">Cerrar</button></div>
    <p className="mt-3 text-sm leading-6 text-[#66796f]">Puedes usar un correo de Apple distinto al de Ordia. Solo se consultarán los calendarios que elijas.</p>
    <ol className="my-5 list-decimal space-y-2 pl-5 text-sm leading-6 text-[#52675d]"><li>Con doble factor activado, abre <a className="font-semibold underline" href="https://account.apple.com/" target="_blank" rel="noopener noreferrer">tu Apple Account</a>.</li><li>En Inicio de sesión y seguridad → Contraseñas específicas de aplicaciones, genera una para Ordia.</li><li>Introduce aquí esa contraseña específica, nunca la contraseña principal de Apple.</li></ol>
    <p className="mb-5 rounded-xl bg-[#f4f7f1] p-3 text-xs leading-5 text-[#66796f]">Ordia solo implementa lectura. La contraseña de Apple puede autorizar más operaciones; no tiene un permiso técnico limitado a lectura. Se enviará al servidor de Ordia y se guardará cifrada para consultar iCloud.</p>
    <fieldset className="grid gap-5" disabled={busy}><FormField data-dialog-initial-focus id="icloud-email" label="Correo de tu Apple Account" autoComplete="off" type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /><FormField id="icloud-password" label="Contraseña específica de aplicación" autoComplete="new-password" type="password" required maxLength={19} value={password} onChange={(event) => setPassword(event.target.value)} hint="Solo permanece en este formulario hasta conectar o cerrarlo. Ordia no puede mostrarla una vez guardada." /></fieldset>
    {error && <div className="mt-5"><AuthNotice tone="error">{error}</AuthNotice></div>}
    <div className="mt-6 flex flex-wrap items-center justify-between gap-4"><a className="text-sm text-[#346a52] underline" href="https://support.apple.com/102654" target="_blank" rel="noopener noreferrer">Instrucciones oficiales de Apple</a><button className="min-h-12 rounded-xl bg-[#173f31] px-5 py-3 font-semibold text-white disabled:opacity-60" disabled={busy} type="submit">{busy ? 'Validando…' : 'Conectar iCloud'}</button></div>
  </form></FormDialog>
}
