import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './useAuth'
import { LoadingScreen } from '../components/LoadingScreen'
import { AuthPage } from '../pages/AuthPage'
import { ConfigurationPendingPage } from '../pages/ConfigurationPendingPage'
import { EmailConfirmedPage } from '../pages/EmailConfirmedPage'
import { UpdatePasswordPage } from '../pages/UpdatePasswordPage'
import { TasksProvider } from '../tasks/TasksProvider'

const FinancePage = lazy(() => import('../pages/FinancePage'))
const TasksPage = lazy(() => import('../pages/TasksPage'))
const CalendarPage = lazy(() => import('../pages/CalendarPage'))

function sanitizeInternalReturnPath(candidate: unknown): string {
  if (typeof candidate !== 'string') return '/'
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/'
  return candidate
}

function ProtectedRoute() {
  const { session } = useAuth()
  const location = useLocation()
  const requestedTarget = `${location.pathname}${location.search}${location.hash}`

  return session
    ? <TasksProvider key={session.user.id} userId={session.user.id}><Outlet /></TasksProvider>
    : <Navigate to="/iniciar-sesion" replace state={{ from: requestedTarget }} />
}

function PublicOnlyRoute() {
  const { session } = useAuth()
  const location = useLocation()
  const target = sanitizeInternalReturnPath((location.state as { from?: unknown } | null)?.from)
  return session ? <Navigate to={target} replace /> : <Outlet />
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
        <Route path="/calendario" element={<Suspense fallback={<LoadingScreen />}><CalendarPage /></Suspense>} />
        <Route path="/tareas" element={<Suspense fallback={<LoadingScreen />}><TasksPage /></Suspense>} />
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
