export type ReminderKind = 'day_before' | 'due_today' | 'overdue'

export function getBogotaClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
  }
}

export function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day + days))
  return value.toISOString().slice(0, 10)
}

export function getReminderKind(dueDate: string, today: string): ReminderKind | null {
  if (dueDate === addDays(today, 1)) return 'day_before'
  if (dueDate === today) return 'due_today'
  if (dueDate < today) return 'overdue'
  return null
}

export function isReminderSendWindow(hour: number) {
  return Number.isInteger(hour) && hour >= 8 && hour <= 20
}
