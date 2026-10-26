import { BrandMark } from '../components/BrandMark'
import { useAuth } from '../auth/useAuth'

export function ConfigurationPendingPage() {
  const { configurationMessage } = useAuth()

  return (
    <div className="grid min-h-screen place-items-center bg-[#f4f7f1] px-5 py-12">
      <main className="w-full max-w-2xl rounded-[32px] border border-[#dce6d9] bg-white p-7 shadow-[0_24px_70px_rgba(23,63,49,0.08)] sm:p-10">
        <BrandMark />
        <p className="mt-10 text-sm font-semibold uppercase tracking-[0.18em] text-[#4f8068]">Configuración pendiente</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-[-0.045em] text-[#173f31] sm:text-4xl">Conecta el proyecto de Supabase de Ordia</h1>
        <p className="mt-4 leading-7 text-[#66796f]">{configurationMessage}</p>

        <div className="mt-8 rounded-2xl bg-[#173f31] p-5 font-mono text-sm leading-7 text-[#dcebdd]" aria-label="Variables necesarias">
          <p>VITE_SUPABASE_URL=...</p>
          <p>VITE_SUPABASE_PUBLISHABLE_KEY=...</p>
        </div>

        <div className="mt-7 space-y-3 text-sm leading-6 text-[#66796f]">
          <p>Crea un archivo <code className="rounded bg-[#edf3ea] px-1.5 py-0.5 text-[#315c49]">.env.local</code> y usa únicamente la URL y la clave publicable del proyecto.</p>
          <p>Nunca agregues una clave secreta o <code className="rounded bg-[#edf3ea] px-1.5 py-0.5 text-[#315c49]">service_role</code> al frontend.</p>
        </div>
      </main>
    </div>
  )
}
