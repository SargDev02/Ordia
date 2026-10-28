import { useEffect, useState } from 'react'

/**
 * Hook para el reloj local del resumen "Eventos de hoy".
 * Se actualiza automáticamente al menos cada minuto y al regresar del segundo plano
 * (eventos de foco y visibilidad del documento).
 * No realiza consultas a los proveedores de calendario.
 */
export function useSummaryClock(): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    function update() {
      setNow(new Date())
    }

    // Intervalo de actualización al menos cada minuto (cada 30 segundos)
    const interval = setInterval(update, 30_000)

    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)

    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  return now
}
