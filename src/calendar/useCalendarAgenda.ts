import { useIcloudCalendar } from './useIcloudCalendar'
import { useGoogleCalendar } from './useGoogleCalendar'
import { unifyCalendars } from './unified'
export function useCalendarAgenda(startOn: string) {
  const icloud = useIcloudCalendar(startOn); const google = useGoogleCalendar(startOn)
  const unified = unifyCalendars([{ provider: 'icloud', snapshot: icloud }, { provider: 'google', snapshot: google }])
  return { icloud, google, ...unified, loading: icloud.loading && google.loading,
    hasWindow: Boolean(icloud.window || google.window),
    realtimeStatus: icloud.realtimeStatus === 'connected' || google.realtimeStatus === 'connected' ? 'connected' as const : icloud.realtimeStatus }
}
