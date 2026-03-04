
-- Support conversations (tickets)
CREATE TABLE public.support_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  channel TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'phone')),
  
  -- Who started the conversation
  initiated_by TEXT NOT NULL DEFAULT 'user' CHECK (initiated_by IN ('user', 'admin')),
  
  -- The user (customer or driver)
  user_type TEXT NOT NULL CHECK (user_type IN ('customer', 'driver')),
  customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
  driver_id UUID REFERENCES public.drivers(id) ON DELETE SET NULL,
  
  -- Admin assignment
  assigned_admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  -- Category/tags
  category TEXT,
  tags TEXT[] DEFAULT '{}',
  
  -- Trip reference (optional)
  trip_id UUID REFERENCES public.trips(id) ON DELETE SET NULL,
  
  -- Timestamps
  last_message_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Ensure either customer or driver is set
  CONSTRAINT valid_user_reference CHECK (
    (user_type = 'customer' AND customer_id IS NOT NULL AND driver_id IS NULL) OR
    (user_type = 'driver' AND driver_id IS NOT NULL AND customer_id IS NULL)
  )
);

-- Support messages within conversations
CREATE TABLE public.support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.support_conversations(id) ON DELETE CASCADE,
  
  -- Who sent it
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'driver', 'admin', 'system')),
  sender_id UUID, -- auth.users id for admin, customers.id for customer, drivers.id for driver
  
  -- Content
  content TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'image', 'file', 'system')),
  
  -- File attachments
  file_url TEXT,
  file_name TEXT,
  file_size INTEGER,
  
  -- Read tracking
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  
  -- Metadata
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Canned responses for quick replies
CREATE TABLE public.canned_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  shortcut TEXT, -- e.g. "/hello" to quickly insert
  is_active BOOLEAN NOT NULL DEFAULT true,
  usage_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX idx_support_conversations_status ON public.support_conversations(status);
CREATE INDEX idx_support_conversations_customer ON public.support_conversations(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_support_conversations_driver ON public.support_conversations(driver_id) WHERE driver_id IS NOT NULL;
CREATE INDEX idx_support_conversations_assigned ON public.support_conversations(assigned_admin_id) WHERE assigned_admin_id IS NOT NULL;
CREATE INDEX idx_support_conversations_last_message ON public.support_conversations(last_message_at DESC);
CREATE INDEX idx_support_messages_conversation ON public.support_messages(conversation_id, created_at);
CREATE INDEX idx_support_messages_unread ON public.support_messages(conversation_id, is_read) WHERE is_read = false;

-- Updated_at triggers
CREATE TRIGGER update_support_conversations_updated_at
  BEFORE UPDATE ON public.support_conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_support_messages_updated_at
  BEFORE UPDATE ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_canned_responses_updated_at
  BEFORE UPDATE ON public.canned_responses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Auto-update last_message_at on conversation when a message is inserted
CREATE OR REPLACE FUNCTION public.update_conversation_last_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.support_conversations
  SET last_message_at = NEW.created_at
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_update_conversation_last_message
  AFTER INSERT ON public.support_messages
  FOR EACH ROW EXECUTE FUNCTION public.update_conversation_last_message();

-- RLS
ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canned_responses ENABLE ROW LEVEL SECURITY;

-- Admin can do everything
CREATE POLICY "Admins full access to conversations"
  ON public.support_conversations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins full access to messages"
  ON public.support_messages FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins full access to canned responses"
  ON public.canned_responses FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Customers can see their own conversations
CREATE POLICY "Customers view own conversations"
  ON public.support_conversations FOR SELECT TO authenticated
  USING (customer_id = public.current_customer_id());

-- Customers can create conversations
CREATE POLICY "Customers create conversations"
  ON public.support_conversations FOR INSERT TO authenticated
  WITH CHECK (customer_id = public.current_customer_id() AND user_type = 'customer');

-- Drivers can see their own conversations
CREATE POLICY "Drivers view own conversations"
  ON public.support_conversations FOR SELECT TO authenticated
  USING (driver_id = public.current_driver_id());

-- Drivers can create conversations
CREATE POLICY "Drivers create conversations"
  ON public.support_conversations FOR INSERT TO authenticated
  WITH CHECK (driver_id = public.current_driver_id() AND user_type = 'driver');

-- Users can see messages in their conversations
CREATE POLICY "Users view messages in own conversations"
  ON public.support_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id = conversation_id
      AND (
        sc.customer_id = public.current_customer_id()
        OR sc.driver_id = public.current_driver_id()
      )
    )
  );

-- Users can send messages to their own conversations
CREATE POLICY "Users send messages to own conversations"
  ON public.support_messages FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.support_conversations sc
      WHERE sc.id = conversation_id
      AND (
        sc.customer_id = public.current_customer_id()
        OR sc.driver_id = public.current_driver_id()
      )
    )
  );

-- Enable realtime for messages
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_conversations;
