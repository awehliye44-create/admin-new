import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface DriverInboxMessage {
  id: string;
  driver_id: string;
  type: string;
  title: string;
  body: string;
  document_type_id: string | null;
  document_id: string | null;
  expiry_date: string | null;
  is_read: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  driver?: {
    first_name: string;
    last_name: string;
    email: string;
  };
}

export function useDriverInboxMessages(driverId?: string) {
  return useQuery({
    queryKey: ["driver-inbox", driverId],
    queryFn: async () => {
      let query = supabase
        .from("driver_inbox_messages")
        .select(`
          *,
          driver:drivers(first_name, last_name, email)
        `)
        .order("created_at", { ascending: false });

      if (driverId) {
        query = query.eq("driver_id", driverId);
      }

      const { data, error } = await query;

      if (error) throw error;
      return data as DriverInboxMessage[];
    },
    enabled: driverId !== undefined || true,
  });
}

export function useUnreadInboxCount(driverId?: string) {
  return useQuery({
    queryKey: ["driver-inbox-unread", driverId],
    queryFn: async () => {
      let query = supabase
        .from("driver_inbox_messages")
        .select("id", { count: "exact", head: true })
        .eq("is_read", false);

      if (driverId) {
        query = query.eq("driver_id", driverId);
      }

      const { count, error } = await query;

      if (error) throw error;
      return count || 0;
    },
  });
}

export function useMarkMessageAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (messageId: string) => {
      const { error } = await supabase
        .from("driver_inbox_messages")
        .update({ is_read: true })
        .eq("id", messageId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["driver-inbox"] });
      queryClient.invalidateQueries({ queryKey: ["driver-inbox-unread"] });
    },
  });
}

export function useMarkAllAsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (driverId: string) => {
      const { error } = await supabase
        .from("driver_inbox_messages")
        .update({ is_read: true })
        .eq("driver_id", driverId)
        .eq("is_read", false);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["driver-inbox"] });
      queryClient.invalidateQueries({ queryKey: ["driver-inbox-unread"] });
      toast.success("All messages marked as read");
    },
  });
}

export function useCreateInboxMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (message: {
      driver_id: string;
      type: string;
      title: string;
      body: string;
      document_type_id?: string | null;
      document_id?: string | null;
      expiry_date?: string | null;
      is_read?: boolean;
    }) => {
      const { data, error } = await supabase
        .from("driver_inbox_messages")
        .insert([message])
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["driver-inbox"] });
      queryClient.invalidateQueries({ queryKey: ["driver-inbox-unread"] });
      toast.success("Message sent to driver inbox");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to send message");
    },
  });
}

export function useDeleteInboxMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (messageId: string) => {
      const { error } = await supabase
        .from("driver_inbox_messages")
        .delete()
        .eq("id", messageId);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["driver-inbox"] });
      queryClient.invalidateQueries({ queryKey: ["driver-inbox-unread"] });
      toast.success("Message deleted");
    },
  });
}
