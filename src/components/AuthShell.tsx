import type { ReactNode } from 'react'
import { BrandMark } from './BrandMark'

interface AuthShellProps {
  children: ReactNode
  description: string
  eyebrow: string
  title: string
}

export function AuthShell({ children, description, eyebrow, title }: AuthShellProps) {
  return (
    <div className="min-h-screen bg-[#f4f7f1] lg:grid lg:grid-cols-[0.9fr_1.1fr]">
      <aside className="relative hidden overflow-hidden bg-[#173f31] p-12 text-white lg:flex lg:min-h-screen lg:flex-col">
        <div className="absolute -right-40 -top-28 size-[34rem] rounded-full border border-white/10" aria-hidden="true" />
        <div className="absolute -bottom-52 -left-24 size-[30rem] rounded-full bg-[#7ac79d]/10 blur-2xl" aria-hidden="true" />
        <div className="relative [&_span:last-child]:text-white">
          <BrandMark />
        </div>
        <div className="relative my-auto max-w-xl py-16">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[#99c0ad]">Tu espacio personal</p>
          <p className="mt-6 text-5xl font-semibold leading-[1.02] tracking-[-0.055em]">Tiempo para lo importante. Claridad para tus finanzas.</p>
          <p className="mt-6 max-w-lg text-lg leading-8 text-[#b8cec3]">Ordia reúne tu organización personal en un entorno privado, sencillo y pensado para avanzar por etapas.</p>
        </div>
        <p className="relative text-sm text-[#8fb3a1]">Tu tiempo y tu dinero, en orden</p>
      </aside>

      <main className="flex min-h-screen flex-col px-5 py-6 sm:px-8 lg:px-12">
        <div className="mb-10 lg:hidden"><BrandMark /></div>
        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center py-8 sm:py-12">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#4f8068]">{eyebrow}</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-[-0.05em] text-[#173f31] sm:text-5xl">{title}</h1>
          <p className="mt-4 leading-7 text-[#66796f]">{description}</p>
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  )
}
