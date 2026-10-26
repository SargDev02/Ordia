import type { Session } from '@supabase/supabase-js'
import { createContext } from 'react'

export interface AuthActionResult {
  error?: string
  message?: string
  requiresEmailConfirmation?: boolean
}

export interface AuthContextValue {
  configurationMessage: string
  isConfigured: boolean
  isLoading: boolean
  isPasswordRecovery: boolean
  session: Session | null
  requestPasswordReset: (email: string) => Promise<AuthActionResult>
  signIn: (email: string, password: string) => Promise<AuthActionResult>
  signOut: () => Promise<AuthActionResult>
  signUp: (email: string, password: string) => Promise<AuthActionResult>
  updatePassword: (password: string) => Promise<AuthActionResult>
}

export const AuthContext = createContext<AuthContextValue | null>(null)
