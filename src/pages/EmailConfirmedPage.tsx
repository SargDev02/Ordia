import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { AuthNotice } from '../components/AuthNotice'
import { AuthShell } from '../components/AuthShell'

export function EmailConfirmedPage() {
  const { session } = useAuth()

  return (
    <AuthShell
      eyebrow="Confirmación de correo"
      title={session ? 'Correo confirmado' : 'Revisa el enlace'}
      description={session
        ? 'Tu dirección quedó confirmada y tu sesión está lista.'
        : 'No encontramos una sesión válida. El enlace pudo vencer o ya fue utilizado.'}
    >
      <AuthNotice tone={session ? 'success' : 'info'}>
        {session ? 'Ya puedes entrar a tu espacio personal de Ordia.' : 'Solicita un nuevo registro o inicia sesión si ya confirmaste tu correo.'}
      </AuthNotice>
      <Link
        className="mt-6 flex w-full items-center justify-center rounded-2xl bg-[#173f31] px-5 py-3.5 font-semibold text-white transition hover:bg-[#245440] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#173f31]"
        to={session ? '/' : '/iniciar-sesion'}
      >
        {session ? 'Ir a Ordia' : 'Ir a iniciar sesión'}
      </Link>
    </AuthShell>
  )
}
