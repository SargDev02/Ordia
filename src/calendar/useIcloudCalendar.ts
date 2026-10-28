import { fetchCalendarSnapshot, invokeCalendar } from '../services/calendar'
import { useCalendarProvider } from './useCalendarProvider'

export function useIcloudCalendar(startOn: string) {
  return useCalendarProvider('icloud', startOn, fetchCalendarSnapshot, invokeCalendar)
}
