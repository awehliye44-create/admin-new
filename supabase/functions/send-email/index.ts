import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'
import { z } from 'npm:zod@3.23.8'
import { requireAdminOrService, escapeHtml } from '../_shared/callerGate.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const FROM_ADDRESS = 'OneCab <noreply@onecab.net>'

const BodySchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(255),
  html: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  replyTo: z.string().email().optional(),
}).refine((d) => d.html || d.text, {
  message: 'Either html or text is required',
})

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not configured')
    return new Response(JSON.stringify({ error: 'Email service not configured' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Admin staff or internal service callers only.
  const callerGate = await requireAdminOrService(req)
  if (!callerGate.ok) return callerGate.response

  const parsed = BodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.flatten() }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  const { to, subject, replyTo } = parsed.data
  const text = parsed.data.text
  // Raw HTML only from trusted internal service callers; staff-supplied HTML is escaped.
  const html = parsed.data.html
    ? (callerGate.isService ? parsed.data.html : `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(parsed.data.html)}</pre>`)
    : undefined

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject,
      html,
      text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  })

  const result = await res.json().catch(() => ({}))

  if (!res.ok) {
    console.error('Resend send failed', { status: res.status, result })
    return new Response(JSON.stringify({ error: 'Failed to send email', details: result }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  console.log('Email sent', { to, subject, id: result?.id })
  return new Response(JSON.stringify({ success: true, id: result?.id }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})