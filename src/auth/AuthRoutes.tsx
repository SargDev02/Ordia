import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './useAuth'
import { LoadingScreen } from '../components/LoadingScreen'
import { AuthPage } from '../pages/AuthPage'
import { ConfigurationPendingPage } from '../pages/ConfigurationPendingPage'
import { EmailConfirmedPage } from '../pages/EmailConfirmedPage'
import { UpdatePasswordPage } from '../pages/UpdatePasswordPage'

const FinancePage = lazy(() => import('../pages/FinancePage'))

function ProtectedRoute() {
  const { session } = useAuth()
  const location = useLocation()

  return session
    ? <Outlet />
    : <Navigate to="/iniciar-sesion" replace state={{ from: location.pathname }} />
}

function PublicOnlyRoute() {
  const { session } = useAuth()
  return session ? <Navigate to="/" replace /> : <Outlet />
}

export function AppRoutes() {
  const { isConfigured, isLoading, session } = useAuth()

  if (isLoading) return <LoadingScreen />
  if (!isConfigured) return <ConfigurationPendingPage />

  return (
    <Routes>
      <Route element={<PublicOnlyRoute />}>
        <Route path="/iniciar-sesion" element={<AuthPage mode="login" />} />
        <Route path="/registro" element={<AuthPage mode="register" />} />
        <Route path="/recuperar-contrasena" element={<AuthPage mode="recovery" />} />
      </Route>
      <Route path="/auth/confirm" element={<EmailConfirmedPage />} />
      <Route path="/restablecer-contrasena" element={<UpdatePasswordPage />} />
      <Route element={<ProtectedRoute />}>
        <Route
          path="/"
          element={(
            <Suspense fallback={<LoadingScreen />}>
              <FinancePage key={session?.user.id} view="home" />
            </Suspense>
          )}
        />
        <Route
          path="/gastos-fijos"
          element={(
            <Suspense fallback={<LoadingScreen />}>
              <FinancePage key={session?.user.id} view="fixed-expenses" />
            </Suspense>
          )}
        />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
