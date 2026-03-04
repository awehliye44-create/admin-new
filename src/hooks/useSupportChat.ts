import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useEffect } from "react";

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
  last_message_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  customer?: { id: string; first_name: string | null; last_name: string | null; phone: string | null };
  driver?: { id: string; first_name: string; last_name: string; email: string; phone: string | null };
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

// Fetch all conversations
export function useSupportConversations(statusFilter?: string) {
  return useQuery({
    queryKey: ["support-conversations", statusFilter],
    queryFn: async () => {
      let query = supabase
        .from("support_conversations")
        .select(`
          *,
          customer:customers(id, first_name, last_name, phone),
          driver:drivers(id, first_name, last_name, email, phone)
        `)
        .order("last_message_at", { ascending: false });

      if (statusFilter && statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }

      const { data, error } = await query;
      if (error) throw error;

      // Get unread counts for each conversation
      const convIds = (data || []).map((c: any) => c.id);
      if (convIds.length > 0) {
        const { data: unreadData } = await supabase
          .from("support_messages")
          .select("conversation_id")
          .in("conversation_id", convIds)
          .eq("is_read", false)
          .neq("sender_type", "admin");

        const unreadMap: Record<string, number> = {};
        (unreadData || []).forEach((m: any) => {
          unreadMap[m.conversation_id] = (unreadMap[m.conversation_id] || 0) + 1;
        });

        return (data || []).map((c: any) => ({
          ...c,
          unread_count: unreadMap[c.id] || 0,
        })) as SupportConversation[];
      }

      return (data || []) as SupportConversation[];
    },
    refetchInterval: 10000,
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
        .select("*")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      return (data || []) as SupportMessage[];
    },
    enabled: !!conversationId,
  });
}

// Send a message
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
    }: {
      conversationId: string;
      content: string;
      contentType?: string;
      fileUrl?: string;
      fileName?: string;
      fileSize?: number;
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

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
        .select("*")
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
    refetchInterval: 15000,
  });
}
