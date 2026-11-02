export type PushChannel = 'fixed_expenses' | 'bank_movements'

export interface PushSubscriptionRecord {
  id: string
  user_id: string
  endpoint: string
  device_label: string
  active: boolean
  notify_fixed_expenses?: boolean
  notify_bank_movements?: boolean
  disabled_at: string | null
  disabled_reason: 'user' | 'expired' | 'reassigned' | null
  last_seen_at: string
  last_success_at: string | null
  created_at: string
  updated_at: string
}

export type PushAvailability =
  | 'checking'
  | 'configuration-pending'
  | 'unsupported'
  | 'ios-install-required'
  | 'denied'
  | 'inactive'
  | 'active'
