import { Resend } from 'resend'

/**
 * Lazy Resend client. The SDK throws in its constructor when the key is
 * missing, which used to take the whole app down at import time (src/lib/auth
 * is imported by nearly every route). Without RESEND_API_KEY every mail send
 * becomes a logged no-op instead, so the app boots for local demos.
 */
let client: Resend | null | undefined

export function getResend(): Resend | null {
  if (client !== undefined) return client
  const key = process.env.RESEND_API_KEY
  client = key ? new Resend(key) : null
  if (!client) console.warn('[resend] RESEND_API_KEY not set; emails are disabled')
  return client
}
