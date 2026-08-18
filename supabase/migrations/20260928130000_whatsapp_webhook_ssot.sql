-- WhatsApp Cloud API webhook — inbound dedupe + per-customer workflow state.
-- Edge Function: whatsapp-webhook (service_role only).

create table if not exists public.whatsapp_inbound_messages (
  meta_message_id text primary key,
  wa_id text not null,
  message_type text not null,
  inbound_text text,
  phone_number_id text,
  raw_payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  workflow_action text
);

create index if not exists whatsapp_inbound_messages_wa_received_idx
  on public.whatsapp_inbound_messages (wa_id, received_at desc);

revoke all on public.whatsapp_inbound_messages from anon, authenticated;
grant all on public.whatsapp_inbound_messages to service_role;
alter table public.whatsapp_inbound_messages enable row level security;

create table if not exists public.whatsapp_conversations (
  wa_id text primary key,
  display_name text,
  workflow_state text not null default 'new'
    check (workflow_state in ('new', 'idle', 'book', 'track', 'support')),
  welcome_sent_at timestamptz,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  support_opened_at timestamptz,
  active_trip_id uuid references public.trips (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_conversations_state_updated_idx
  on public.whatsapp_conversations (workflow_state, updated_at desc);

revoke all on public.whatsapp_conversations from anon, authenticated;
grant all on public.whatsapp_conversations to service_role;
alter table public.whatsapp_conversations enable row level security;
