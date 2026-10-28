import { useEffect, useState } from 'react'
import { getBogotaToday } from '../finance/calculations'

export function useBogotaToday() {
  const [today, setToday] = useState(() => getBogotaToday())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    function update() {
      const now = new Date()
      const current = getBogotaToday(now)
      setToday(current)
      const midnight = new Date(`${current}T00:00:00-05:00`).getTime() + 24 * 60 * 60 * 1000
      clearTimeout(timer)
      timer = setTimeout(update, Math.max(50, midnight - now.getTime() + 50))
    }
    update()
    window.addEventListener('focus', update)
    document.addEventListener('visibilitychange', update)
    return () => { clearTimeout(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update) }
  }, [])
  return today
}
