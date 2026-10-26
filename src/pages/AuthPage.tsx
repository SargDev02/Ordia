import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { AuthNotice } from '../components/AuthNotice'
import { AuthShell } from '../components/AuthShell'
import { FormField } from '../components/FormField'

type AuthMode = 'login' | 'register' | 'recovery'

interface AuthPageProps {
  mode: AuthMode
}

const content = {
  login: {
    eyebrow: 'Bienvenido de nuevo',
    title: 'Inicia sesión',
    description: 'Accede a tu espacio personal con tu correo y contraseña.',
    submit: 'Entrar a Ordia',
  },
  register: {
    eyebrow: 'Crea tu espacio',
    title: 'Regístrate',
    description: 'Usa un correo al que tengas acceso. Te pediremos confirmarlo antes de entrar.',
    submit: 'Crear mi cuenta',
  },
  recovery: {
    eyebrow: 'Recupera el acceso',
    title: 'Restablece tu contraseña',
    description: 'Escribe tu correo y te enviaremos un enlace seguro para definir una nueva contraseña.',
    submit: 'Enviar enlace',
  },
} satisfies Record<AuthMode, { eyebrow: string; title: string; description: string; submit: string }>

export function AuthPage({ mode }: AuthPageProps) {
  const { requestPasswordReset, signIn, signUp } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirmation, setPasswordConfirmation] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const pageContent = content[mode]

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')

    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) {
      setError('Escribe tu correo electrónico.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setError('Escribe un correo electrónico válido.')
      return
    }

    if (mode !== 'recovery' && password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.')
      return
    }

    if (mode === 'register' && password !== passwordConfirmation) {
      setError('Las contraseñas no coinciden.')
      return
    }

    setIsSubmitting(true)
    const result = mode === 'login'
      ? await signIn(normalizedEmail, password)
      : mode === 'register'
        ? await signUp(normalizedEmail, password)
        : await requestPasswordReset(normalizedEmail)
    setIsSubmitting(false)

    if (result.error) setError(result.error)
    if (result.message) setMessage(result.message)
  }

  return (
    <AuthShell {...pageContent}>
      <form className="space-y-5" onSubmit={handleSubmit} noValidate aria-busy={isSubmitting}>
        {error && <AuthNotice tone="error">{error}</AuthNotice>}
        {message && <AuthNotice tone="success">{message}</AuthNotice>}

        <FormField
          autoComplete="email"
          disabled={isSubmitting}
          id={`${mode}-email`}
          label="Correo electrónico"
          name="email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="tu@correo.com"
          required
          type="email"
          value={email}
        />

        {mode !== 'recovery' && (
          <FormField
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            disabled={isSubmitting}
            hint={mode === 'register' ? 'Usa al menos 8 caracteres.' : undefined}
            id={`${mode}-password`}
            label="Contraseña"
            minLength={8}
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        )}

        {mode === 'register' && (
          <FormField
            autoComplete="new-password"
            disabled={isSubmitting}
            id="register-password-confirmation"
            label="Confirma tu contraseña"
            minLength={8}
            name="password-confirmation"
            onChange={(event) => setPasswordConfirmation(event.target.value)}
            required
            type="password"
            value={passwordConfirmation}
          />
        )}

        {mode === 'login' && (
          <div className="text-right">
            <Link className="text-sm font-medium text-[#346a52] underline-offset-4 hover:underline" to="/recuperar-contrasena">¿Olvidaste tu contraseña?</Link>
          </div>
        )}

        <button
          className="flex w-full items-center justify-center rounded-2xl bg-[#173f31] px-5 py-3.5 font-semibold text-white transition hover:bg-[#245440] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#173f31] disabled:cursor-wait disabled:opacity-65"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? 'Procesando…' : pageContent.submit}
        </button>
      </form>

      <p className="mt-7 text-center text-sm text-[#66796f]">
        {mode === 'login' && <>¿Aún no tienes cuenta? <Link className="font-semibold text-[#346a52] hover:underline" to="/registro">Regístrate</Link></>}
        {mode === 'register' && <>¿Ya tienes cuenta? <Link className="font-semibold text-[#346a52] hover:underline" to="/iniciar-sesion">Inicia sesión</Link></>}
        {mode === 'recovery' && <Link className="font-semibold text-[#346a52] hover:underline" to="/iniciar-sesion">Volver a iniciar sesión</Link>}
      </p>
    </AuthShell>
  )
}
