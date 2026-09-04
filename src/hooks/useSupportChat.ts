import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useEffect } from "react";
import { isAdminPageLiveActive } from "@/lib/adminPageVisibility";
import { ADMIN_SUPPORT_INBOX_PAGE_SIZE } from "@/lib/adminQueryBounds";

export interface SupportConversation {
  id: string;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  initiated_by: string;
  user_type: string;
  customer_id: string | null;
  driver_id: string | null;
  assigned_admin_id: string | null;
  category: string | null;
  tags: string[];
  trip_id: string | null;
  wa_id: string | null;
  guest_name?: string | null;
  guest_email?: string | null;
  last_message_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  customer?: { id: string; first_name: string | null; last_name: string | null; phone: string | null };
  driver?: { id: string; first_name: string; last_name: string; email?: string | null; phone: string | null; driver_code?: string | null };
  latest_message?: SupportMessage;
  unread_count?: number;
}

export interface SupportMessage {
  id: string;
  conversation_id: string;
  sender_type: string;
  sender_id: string | null;
  content: string;
  content_type: string;
  file_url: string | null;
  file_name: string | null;
  file_size: number | null;
  is_read: boolean;
  read_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CannedResponse {
  id: string;
  title: string;
  content: string;
  category: string | null;
  shortcut: string | null;
  is_active: boolean;
  usage_count: number;
  created_at: string;
}

type LiveChatDriverIdentity = {
  id: string;
  first_name: string;
  last_name: string;
  driver_code: string | null;
  phone: string | null;
};

/**
 * Optional identity enrichment. Failures here MUST NOT fail the inbox.
 * WhatsApp/website conversations do not need drivers at all.
 */
async function enrichSupportIdentities(rows: SupportConversation[]): Promise<SupportConversation[]> {
  if (rows.length === 0) return rows;

  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter((id): id is string => !!id))];
  const driverIds = [...new Set(rows.map((r) => r.driver_id).filter((id): id is string => !!id))];

  const customerMap: Record<string, NonNullable<SupportConversation["customer"]>> = {};
  const driverMap: Record<string, NonNullable<SupportConversation["driver"]>> = {};

  if (customerIds.length > 0) {
    try {
      const { data, error } = await supabase
        .from("customers")
        .select("id, first_name, last_name, phone")
        .in("id", customerIds);
      if (!error) {
        (data || []).forEach((c) => {
          customerMap[c.id] = c;
        });
      }
    } catch {
      /* keep the conversation list without customer names */
    }
  }

  if (driverIds.length > 0) {
    try {
      const { data, error } = await supabase.rpc("admin_live_chat_driver_identity", {
        p_ids: driverIds,
      });
      if (!error) {
        ((data || []) as LiveChatDriverIdentity[]).forEach((d) => {
          driverMap[d.id] = {
            id: d.id,
            first_name: d.first_name,
            last_name: d.last_name,
            phone: d.phone,
            driver_code: d.driver_code,
          };
        });
      }
    } catch {
      /* keep the conversation list without driver names */
    }
  }

  return rows.map((r) => ({
    ...r,
    customer: r.customer_id ? customerMap[r.customer_id] : undefined,
    driver: r.driver_id ? driverMap[r.driver_id] : undefined,
  }));
}

// Fetch all conversations + subscribe to Realtime so new WhatsApp (and any
// channel) conversations appear immediately without waiting for the poll cycle.
export function useSupportConversations(
  statusFilter?: string,
  pageSize: number = ADMIN_SUPPORT_INBOX_PAGE_SIZE,
) {
  const queryClient = useQueryClient();

  // Realtime: invalidate on any INSERT or UPDATE to support_conversations or
  // support_messages so the list and unread badges refresh live.
  useEffect(() => {
    // Topic must be unique per subscriber: realtime-js shares join state by
    // topic, so a second channel with the same name (widget + page mounted
    // together) throws "cannot add callbacks after subscribe()".
    const convChannel = supabase
      .channel(`support-conversations-live-${Math.random().toString(36).slice(2, 10)}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "support_conversations" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
          queryClient.invalidateQueries({ queryKey: ["support-unread-count"] });
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "support_messages" },
        () => {
          queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
          queryClient.invalidateQueries({ queryKey: ["support-unread-count"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(convChannel);
    };
  }, [queryClient]);

  return useQuery({
    queryKey: ["support-conversations", statusFilter, pageSize],
    queryFn: async () => {
      // Base query MUST NOT embed the drivers table. Production `authenticated`
      // has no SELECT on public.drivers, so PostgREST relation expansion of
      // that FK fails the entire inbox with:
      //   permission denied for table drivers
      // even for WhatsApp/website rows that have driver_id = null.
      // Newest-first bound — Load more raises pageSize; Realtime still invalidates.
      let query = supabase
        .from("support_conversations")
        .select(
          "id, subject, status, priority, channel, initiated_by, user_type, customer_id, driver_id, assigned_admin_id, category, tags, trip_id, wa_id, guest_name, guest_email, last_message_at, resolved_at, created_at, updated_at",
        )
        .order("last_message_at", { ascending: false })
        .limit(pageSize);

      if (statusFilter && statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }

      const { data, error } = await query;
      if (error) throw error;

      const rows = await enrichSupportIdentities((data || []) as SupportConversation[]);

      const convIds = rows.map((c) => c.id);
      if (convIds.length > 0) {
        const { data: unreadData } = await supabase
          .from("support_messages")
          .select("conversation_id")
          .in("conversation_id", convIds)
          .eq("is_read", false)
          .neq("sender_type", "admin");

        const unreadMap: Record<string, number> = {};
        (unreadData || []).forEach((m: { conversation_id: string }) => {
          unreadMap[m.conversation_id] = (unreadMap[m.conversation_id] || 0) + 1;
        });

        return rows.map((c) => ({
          ...c,
          unread_count: unreadMap[c.id] || 0,
        }));
      }

      return rows;
    },
    refetchInterval: () => {
      if (!isAdminPageLiveActive()) return false;
      return 60_000;
    },
    refetchIntervalInBackground: false,
  });
}

// Fetch messages for a conversation
export function useSupportMessages(conversationId: string | null) {
  const queryClient = useQueryClient();

  // Real-time subscription
  useEffect(() => {
    if (!conversationId) return;

    const channel = supabase
      .channel(`support-messages-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "support_messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["support-messages", conversationId] });
          queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId, queryClient]);

  return useQuery({
    queryKey: ["support-messages", conversationId],
    queryFn: async () => {
      if (!conversationId) return [];
      const { data, error } = await supabase
        .from("support_messages")
        .select(
          "id, conversation_id, sender_type, sender_id, content, content_type, file_url, file_name, file_size, is_read, read_at, metadata, created_at, updated_at",
        )
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      return (data || []) as SupportMessage[];
    },
    enabled: !!conversationId,
  });
}

// Send a message — routes WhatsApp conversations through the protected
// whatsapp-reply Edge Function so the Meta token never reaches the browser.
export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      content,
      contentType = "text",
      fileUrl,
      fileName,
      fileSize,
      channel,
    }: {
      conversationId: string;
      content: string;
      contentType?: string;
      fileUrl?: string;
      fileName?: string;
      fileSize?: number;
      channel?: string;
    }) => {
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (!user || authErr) throw new Error("Not authenticated");

      if (channel === "whatsapp") {
        // Route through protected Edge Function — token stays server-side.
        const { data: { session } } = await supabase.auth.getSession();
        const accessToken = session?.access_token;
        if (!accessToken) throw new Error("No session token");

        const supabaseUrl = (supabase as unknown as { supabaseUrl?: string }).supabaseUrl
          ?? `https://${window.location.hostname.replace(/^[^.]+/, "thazislrdkjpvvghtvzo")}.supabase.co`;

        const res = await fetch(`${supabaseUrl}/functions/v1/whatsapp-reply`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ support_conversation_id: conversationId, content }),
        });

        const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
        if (!res.ok || !json.ok) {
          throw new Error(json.error || "WhatsApp send failed");
        }
        return json;
      }

      // Standard in-app / non-WhatsApp send.
      const { data, error } = await supabase
        .from("support_messages")
        .insert({
          conversation_id: conversationId,
          sender_type: "admin",
          sender_id: user.id,
          content,
          content_type: contentType,
          file_url: fileUrl || null,
          file_name: fileName || null,
          file_size: fileSize || null,
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["support-messages", variables.conversationId] });
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to send message");
    },
  });
}

// Resolve a WhatsApp support conversation — sends the closure message via
// the protected whatsapp-resolve Edge Function, then resets WhatsApp state.
export function useResolveWhatsAppConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) throw new Error("No session token");

      const supabaseUrl = (supabase as unknown as { supabaseUrl?: string }).supabaseUrl
        ?? `https://thazislrdkjpvvghtvzo.supabase.co`;

      const res = await fetch(`${supabaseUrl}/functions/v1/whatsapp-resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ support_conversation_id: conversationId }),
      });

      const json = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        throw new Error(json.error || "WhatsApp resolve failed");
      }
      return json;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
      queryClient.invalidateQueries({ queryKey: ["support-messages"] });
      toast.success("Support conversation closed and customer notified");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to close conversation");
    },
  });
}

// Create a new conversation (admin-initiated)
export function useCreateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      subject,
      userType,
      customerId,
      driverId,
      priority = "normal",
      category,
      initialMessage,
    }: {
      subject: string;
      userType: "customer" | "driver";
      customerId?: string;
      driverId?: string;
      priority?: string;
      category?: string;
      initialMessage: string;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Create conversation
      const { data: conv, error: convError } = await supabase
        .from("support_conversations")
        .insert({
          subject,
          user_type: userType,
          customer_id: customerId || null,
          driver_id: driverId || null,
          initiated_by: "admin",
          assigned_admin_id: user.id,
          priority,
          category: category || null,
        })
        .select()
        .single();

      if (convError) throw convError;

      // Send initial message
      const { error: msgError } = await supabase
        .from("support_messages")
        .insert({
          conversation_id: conv.id,
          sender_type: "admin",
          sender_id: user.id,
          content: initialMessage,
        });

      if (msgError) throw msgError;
      return conv;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
      toast.success("Conversation created");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create conversation");
    },
  });
}

// Update conversation status/priority/assignment
export function useUpdateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: {
      id: string;
      status?: string;
      priority?: string;
      assigned_admin_id?: string | null;
      category?: string;
      resolved_at?: string | null;
    }) => {
      const { error } = await supabase
        .from("support_conversations")
        .update(updates)
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
      toast.success("Conversation updated");
    },
  });
}

// Mark messages as read
export function useMarkMessagesRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      const { error } = await supabase
        .from("support_messages")
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq("conversation_id", conversationId)
        .eq("is_read", false)
        .neq("sender_type", "admin");

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["support-conversations"] });
    },
  });
}

// Canned responses
export function useCannedResponses() {
  return useQuery({
    queryKey: ["canned-responses"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("canned_responses")
        .select("id, title, content, category, shortcut, is_active, usage_count, created_at")
        .eq("is_active", true)
        .order("usage_count", { ascending: false });

      if (error) throw error;
      return (data || []) as CannedResponse[];
    },
  });
}

export function useSaveCannedResponse() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (response: { id?: string; title: string; content: string; category?: string; shortcut?: string }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (response.id) {
        const { error } = await supabase
          .from("canned_responses")
          .update({ title: response.title, content: response.content, category: response.category, shortcut: response.shortcut })
          .eq("id", response.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("canned_responses")
          .insert({ ...response, created_by: user?.id });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["canned-responses"] });
      toast.success("Canned response saved");
    },
  });
}

export function useDeleteCannedResponse() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("canned_responses").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["canned-responses"] });
      toast.success("Canned response deleted");
    },
  });
}

// Unread count for sidebar badge
export function useUnreadSupportCount() {
  return useQuery({
    queryKey: ["support-unread-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("support_messages")
        .select("id", { count: "exact", head: true })
        .eq("is_read", false)
        .neq("sender_type", "admin");

      if (error) throw error;
      return count || 0;
    },
    refetchInterval: () => {
      if (!isAdminPageLiveActive()) return false;
      return 60_000;
    },
    refetchIntervalInBackground: false,
  });
}
