import { fetchGoogleSnapshot, invokeGoogleCalendar } from '../services/googleCalendar'
import { useCalendarProvider } from './useCalendarProvider'
export function useGoogleCalendar(startOn: string) {
  return useCalendarProvider('google', startOn, fetchGoogleSnapshot, invokeGoogleCalendar)
}
