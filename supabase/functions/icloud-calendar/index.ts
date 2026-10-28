import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from '@supabase/supabase-js'
import { createIcloudHandler } from '../_shared/icloud/handler.ts'

const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>
const admin = createClient(Deno.env.get('SUPABASE_URL')!, keys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
Deno.serve(createIcloudHandler({ encryptionKey: Deno.env.get('ICLOUD_CREDENTIAL_ENCRYPTION_KEY') ?? '' }, admin))
