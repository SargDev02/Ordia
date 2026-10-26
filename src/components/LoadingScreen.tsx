import { BrandMark } from './BrandMark'

export function LoadingScreen() {
  return (
    <div className="grid min-h-screen place-items-center bg-[#f4f7f1] px-5">
      <div className="text-center" role="status" aria-live="polite">
        <div className="flex justify-center"><BrandMark /></div>
        <div className="mx-auto mt-8 size-8 animate-spin rounded-full border-2 border-[#c9dacb] border-t-[#2f674f]" aria-hidden="true" />
        <p className="mt-4 text-sm text-[#66796f]">Preparando tu espacio…</p>
      </div>
    </div>
  )
}
