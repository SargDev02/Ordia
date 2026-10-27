import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AuthContext, type AuthContextValue } from './auth-context'
import { getAuthErrorMessage } from './auth-errors'
import {
  isSupabaseConfigured,
  supabase,
  supabaseConfigurationMessage,
} from '../services/supabase'
import { deactivatePushOnCurrentDevice } from '../services/pushNotifications'

interface AuthProviderProps {
  children: ReactNode
  client?: SupabaseClient | null
  configured?: boolean
}

function confirmationRedirectUrl() {
  return `${window.location.origin}/auth/confirm`
}

function passwordRecoveryRedirectUrl() {
  return `${window.location.origin}/restablecer-contrasena`
}

export function AuthProvider({ children, client, configured }: AuthProviderProps) {
  const activeClient = client === undefined ? supabase : client
  const activeConfiguration = configured ?? isSupabaseConfigured
  const [session, setSession] = useState<Session | null>(null)
  const [isLoading, setIsLoading] = useState(Boolean(activeConfiguration && activeClient))
  const [isPasswordRecovery, setIsPasswordRecovery] = useState(false)

  useEffect(() => {
    if (!activeConfiguration || !activeClient) {
      return
    }

    let isMounted = true
    let receivedAuthEvent = false

    const { data: { subscription } } = activeClient.auth.onAuthStateChange(
      (event: AuthChangeEvent, nextSession: Session | null) => {
        if (!isMounted) return

        receivedAuthEvent = true
        setSession(nextSession)
        setIsLoading(false)

        if (event === 'PASSWORD_RECOVERY') setIsPasswordRecovery(true)
        if (event === 'SIGNED_OUT') {
          setIsPasswordRecovery(false)
          void deactivatePushOnCurrentDevice(null).catch(() => undefined)
        }
      },
    )

    void activeClient.auth.getSession().then(({ data }) => {
      if (!isMounted || receivedAuthEvent) return
      setSession(data.session)
      setIsLoading(false)
    }).catch(() => {
      if (!isMounted) return
      setSession(null)
      setIsLoading(false)
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [activeClient, activeConfiguration])

  const value = useMemo<AuthContextValue>(() => ({
    configurationMessage: supabaseConfigurationMessage,
    isConfigured: activeConfiguration,
    isLoading,
    isPasswordRecovery,
    session,
    async signUp(email, password) {
      if (!activeClient) return { error: supabaseConfigurationMessage }

      const { data, error } = await activeClient.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: confirmationRedirectUrl() },
      })

      if (error) return { error: getAuthErrorMessage(error) }
      if (!data.session) {
        return {
          message: 'Te enviamos un enlace para confirmar tu correo. Revísalo antes de iniciar sesión.',
          requiresEmailConfirmation: true,
        }
      }

      return { message: 'Tu cuenta quedó creada.' }
    },
    async signIn(email, password) {
      if (!activeClient) return { error: supabaseConfigurationMessage }
      const { error } = await activeClient.auth.signInWithPassword({ email, password })
      return error ? { error: getAuthErrorMessage(error) } : {}
    },
    async signOut() {
      if (!activeClient) return {}

      try {
        await deactivatePushOnCurrentDevice(activeClient)
      } catch {
        // La suscripción del proveedor se invalida localmente aunque la API no responda.
      }
      setSession(null)
      setIsPasswordRecovery(false)
      const { error } = await activeClient.auth.signOut()
      return error ? { error: getAuthErrorMessage(error) } : {}
    },
    async requestPasswordReset(email) {
      if (!activeClient) return { error: supabaseConfigurationMessage }
      const { error } = await activeClient.auth.resetPasswordForEmail(email, {
        redirectTo: passwordRecoveryRedirectUrl(),
      })

      if (error) return { error: getAuthErrorMessage(error) }
      return { message: 'Si existe una cuenta con ese correo, recibirás un enlace para restablecer la contraseña.' }
    },
    async updatePassword(password) {
      if (!activeClient) return { error: supabaseConfigurationMessage }
      const { error } = await activeClient.auth.updateUser({ password })
      if (error) return { error: getAuthErrorMessage(error) }

      setSession(null)
      setIsPasswordRecovery(false)
      await activeClient.auth.signOut()
      return { message: 'Tu contraseña fue actualizada. Ya puedes iniciar sesión con ella.' }
    },
  }), [activeClient, activeConfiguration, isLoading, isPasswordRecovery, session])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
