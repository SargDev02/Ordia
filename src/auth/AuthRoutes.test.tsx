import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AuthProvider } from './AuthContext'
import { AppRoutes } from './AuthRoutes'

type AuthListener = (event: AuthChangeEvent, session: Session | null) => void

function sessionFor(email: string): Session {
  return {
    access_token: 'test-access-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    expires_in: 3600,
    refresh_token: 'test-refresh-token',
    token_type: 'bearer',
    user: {
      app_metadata: {},
      aud: 'authenticated',
      created_at: new Date(0).toISOString(),
      email,
      id: `user-${email}`,
      user_metadata: {},
    },
  }
}

function createFakeClient(initialSession: Session | null, pending = false) {
  let listener: AuthListener | undefined
  const neverResolves = new Promise<never>(() => undefined)
  const signOut = vi.fn().mockResolvedValue({ error: null })

  const client = {
    auth: {
      getSession: vi.fn(() => pending
        ? neverResolves
        : Promise.resolve({ data: { session: initialSession }, error: null })),
      onAuthStateChange: vi.fn((callback: AuthListener) => {
        listener = callback
        return { data: { subscription: { unsubscribe: vi.fn() } } }
      }),
      resetPasswordForEmail: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut,
      signUp: vi.fn(),
      updateUser: vi.fn(),
    },
  } as unknown as SupabaseClient

  return {
    client,
    emit(event: AuthChangeEvent, session: Session | null) {
      if (!listener) throw new Error('El listener todavía no está registrado')
      listener(event, session)
    },
    signOut,
  }
}

function renderRoutes(client: SupabaseClient, initialPath = '/') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider client={client} configured>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('rutas y sesión', () => {
  it('muestra una guía de configuración cuando faltan variables públicas', () => {
    render(
      <MemoryRouter>
        <AuthProvider client={null} configured={false}>
          <AppRoutes />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { name: 'Conecta el proyecto de Supabase de Ordia' })).toBeInTheDocument()
    expect(screen.getByText('VITE_SUPABASE_PUBLISHABLE_KEY=...')).toBeInTheDocument()
  })

  it('no muestra contenido privado mientras restaura la sesión', () => {
    const fake = createFakeClient(null, true)
    renderRoutes(fake.client)

    expect(screen.getByText('Preparando tu espacio…')).toBeInTheDocument()
    expect(screen.queryByText('Módulos previstos')).not.toBeInTheDocument()
  })

  it('redirige a iniciar sesión cuando la ruta protegida no tiene sesión', async () => {
    const fake = createFakeClient(null)
    renderRoutes(fake.client)

    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument()
    expect(screen.queryByText('Módulos previstos')).not.toBeInTheDocument()
  })

  it('reemplaza el contenido visible al iniciar y cerrar sesión', async () => {
    const fake = createFakeClient(null)
    renderRoutes(fake.client)
    await screen.findByRole('heading', { name: 'Inicia sesión' })

    act(() => fake.emit('SIGNED_IN', sessionFor('primera@ordia.test')))
    expect(await screen.findByText('primera@ordia.test')).toBeInTheDocument()
    expect(screen.getByText('Finanzas personales')).toBeInTheDocument()

    act(() => fake.emit('SIGNED_OUT', null))
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument()
    expect(screen.queryByText('primera@ordia.test')).not.toBeInTheDocument()
  })

  it('habilita el cambio de contraseña al recibir PASSWORD_RECOVERY', async () => {
    const fake = createFakeClient(null)
    renderRoutes(fake.client, '/restablecer-contrasena')
    await screen.findByText('El enlace de recuperación no es válido o ya venció. Solicita uno nuevo.')

    act(() => fake.emit('PASSWORD_RECOVERY', sessionFor('recuperacion@ordia.test')))

    expect(await screen.findByText('Enlace verificado. Ahora puedes cambiar tu contraseña.')).toBeInTheDocument()
    expect(screen.getByLabelText('Nueva contraseña')).toBeInTheDocument()
  })

  it('oculta la sesión actual inmediatamente al usar cerrar sesión', async () => {
    const user = userEvent.setup()
    const fake = createFakeClient(sessionFor('usuario@ordia.test'))
    renderRoutes(fake.client)

    await screen.findByText('usuario@ordia.test')
    await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }))

    expect(fake.signOut).toHaveBeenCalledOnce()
    expect(await screen.findByRole('heading', { name: 'Inicia sesión' })).toBeInTheDocument()
    expect(screen.queryByText('usuario@ordia.test')).not.toBeInTheDocument()
  })
})
