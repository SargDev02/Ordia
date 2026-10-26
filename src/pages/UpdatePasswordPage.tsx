import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { AuthNotice } from '../components/AuthNotice'
import { AuthShell } from '../components/AuthShell'
import { FormField } from '../components/FormField'

export function UpdatePasswordPage() {
  const { isPasswordRecovery, session, updatePassword } = useAuth()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')

    if (password.length < 8) {
      setError('La nueva contraseña debe tener al menos 8 caracteres.')
      return
    }
    if (password !== confirmation) {
      setError('Las contraseñas no coinciden.')
      return
    }

    setIsSubmitting(true)
    const result = await updatePassword(password)
    setIsSubmitting(false)
    if (result.error) setError(result.error)
    if (result.message) setMessage(result.message)
  }

  return (
    <AuthShell
      eyebrow="Enlace de recuperación"
      title="Define una nueva contraseña"
      description="Elige una contraseña nueva para recuperar el acceso a tu cuenta."
    >
      {!session ? (
        <>
          <AuthNotice tone="error">El enlace de recuperación no es válido o ya venció. Solicita uno nuevo.</AuthNotice>
          <Link className="mt-6 flex w-full justify-center rounded-2xl bg-[#173f31] px-5 py-3.5 font-semibold text-white" to="/recuperar-contrasena">Solicitar otro enlace</Link>
        </>
      ) : message ? (
        <>
          <AuthNotice tone="success">{message}</AuthNotice>
          <Link className="mt-6 flex w-full justify-center rounded-2xl bg-[#173f31] px-5 py-3.5 font-semibold text-white" to="/iniciar-sesion">Iniciar sesión</Link>
        </>
      ) : (
        <form className="space-y-5" onSubmit={handleSubmit} noValidate aria-busy={isSubmitting}>
          {isPasswordRecovery && <AuthNotice tone="info">Enlace verificado. Ahora puedes cambiar tu contraseña.</AuthNotice>}
          {error && <AuthNotice tone="error">{error}</AuthNotice>}
          <FormField
            autoComplete="new-password"
            disabled={isSubmitting}
            hint="Usa al menos 8 caracteres."
            id="new-password"
            label="Nueva contraseña"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
          <FormField
            autoComplete="new-password"
            disabled={isSubmitting}
            id="new-password-confirmation"
            label="Confirma la nueva contraseña"
            minLength={8}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            type="password"
            value={confirmation}
          />
          <button
            className="flex w-full justify-center rounded-2xl bg-[#173f31] px-5 py-3.5 font-semibold text-white transition hover:bg-[#245440] disabled:cursor-wait disabled:opacity-65"
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting ? 'Actualizando…' : 'Guardar nueva contraseña'}
          </button>
        </form>
      )}
    </AuthShell>
  )
}
