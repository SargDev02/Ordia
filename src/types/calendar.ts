export interface IcloudConnection { id: string; user_id: string; generation: string; status: 'connected' | 'reconnect' | 'disconnected'; error_code: string | null; updated_at: string }
export type CalendarProvider = 'icloud' | 'google'
export interface IcloudCalendar { id: string; connection_id: string; user_id: string; name: string; color: string; selected: boolean; provider?: CalendarProvider }
export interface CalendarWindow { id: string; connection_id: string; user_id: string; generation: string; start_on: string; end_on: string; synced_at: string }
export interface CalendarEvent {
  provider?: CalendarProvider
  id: string; window_id: string; calendar_id: string; user_id: string; occurrence_key: string;
  title: string; description: string; location: string; url: string | null;
  all_day: boolean; starts_at: string | null; ends_at: string | null; start_on: string | null; end_on: string | null
}
export interface CalendarSnapshot { connection: IcloudConnection | null; calendars: IcloudCalendar[]; window: CalendarWindow | null; events: CalendarEvent[] }
