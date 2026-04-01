import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useState, useEffect, useCallback } from 'react';

export interface LostPropertyCase {
  id: string;
  case_number: string;
  trip_id: string;
  driver_id: string;
  customer_id: string;
  service_area_id: string;
  item_category: string;
  item_description: string;
  photos: string[] | null;
  found_item_photos: string[] | null;
  driver_photos: string[] | null;
  status: string;
  return_method: string | null;
  return_trip_id: string | null;
  customer_confirmed: boolean | null;
  chat_enabled: boolean;
  chat_opened_at: string | null;
  chat_expires_at: string;
  chat_locked_at: string | null;
  chat_lock_reason: string | null;
  admin_joined_at: string | null;
  photos_hidden_at: string | null;
  photos_delete_at: string | null;
  admin_viewed_at: string | null;
  admin_last_read_message_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  // Enriched fields (resolved client-side)
  customer_name?: string;
  driver_name?: string;
  has_unread_messages?: boolean;
}

export interface LostPropertyMessage {
  id: string;
  case_id: string;
  sender_type: string;
  sender_id: string | null;
  message: string;
  attachments: string[] | null;
  created_at: string;
}

export interface TripSummary {
  id: string;
  pickup_address: string | null;
  dropoff_address: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

const LP_STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  SENT_TO_DRIVER: 'Sent to Driver',
  DRIVER_CONFIRMED_FOUND: 'Driver Confirmed',
  DRIVER_NOT_FOUND: 'Not Found',
  AWAITING_CUSTOMER_CONFIRMATION: 'Awaiting Confirmation',
  AWAITING_RETURN_METHOD: 'Awaiting Return Method',
  AWAITING_COLLECTION: 'Awaiting Collection',
  RETURN_RIDE_REQUESTED: 'Return Ride Requested',
  RETURN_RIDE_BOOKED: 'Return Ride Booked',
  ESCALATED: 'Escalated',
  CLOSED: 'Closed',
};

const LP_STATUS_COLORS: Record<string, string> = {
  NEW: 'bg-blue-500',
  SENT_TO_DRIVER: 'bg-yellow-500',
  DRIVER_CONFIRMED_FOUND: 'bg-green-500',
  DRIVER_NOT_FOUND: 'bg-red-500',
  AWAITING_CUSTOMER_CONFIRMATION: 'bg-orange-500',
  AWAITING_RETURN_METHOD: 'bg-purple-500',
  AWAITING_COLLECTION: 'bg-indigo-500',
  RETURN_RIDE_REQUESTED: 'bg-cyan-500',
  RETURN_RIDE_BOOKED: 'bg-teal-500',
  ESCALATED: 'bg-red-600',
  CLOSED: 'bg-gray-500',
};

export { LP_STATUS_LABELS, LP_STATUS_COLORS };

// Resolve customer & driver names for a set of cases
async function enrichCasesWithNames(cases: LostPropertyCase[]): Promise<LostPropertyCase[]> {
  if (cases.length === 0) return cases;

  const customerIds = [...new Set(cases.map(c => c.customer_id).filter(Boolean))];
  const driverIds = [...new Set(cases.map(c => c.driver_id).filter(Boolean))];

  const [customersRes, driversRes] = await Promise.all([
    customerIds.length > 0
      ? supabase.from('customers').select('id, first_name, last_name').in('id', customerIds)
      : Promise.resolve({ data: [] }),
    driverIds.length > 0
      ? supabase.from('drivers').select('id, first_name, last_name').in('id', driverIds)
      : Promise.resolve({ data: [] }),
  ]);

  const customerMap = new Map((customersRes.data ?? []).map((c: any) => [c.id, `${c.first_name || ''} ${c.last_name || ''}`.trim()]));
  const driverMap = new Map((driversRes.data ?? []).map((d: any) => [d.id, `${d.first_name || ''} ${d.last_name || ''}`.trim()]));

  return cases.map(c => ({
    ...c,
    customer_name: customerMap.get(c.customer_id) || undefined,
    driver_name: driverMap.get(c.driver_id) || undefined,
  }));
}

export function useLostPropertyCases(filters?: {
  status?: string;
  serviceAreaId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  return useQuery({
    queryKey: ['lost-property-cases', filters],
    queryFn: async () => {
      let query = supabase
        .from('lost_property_cases')
        .select('*')
        .order('updated_at', { ascending: false });

      if (filters?.status && filters.status !== 'all') {
        query = query.eq('status', filters.status);
      }
      if (filters?.serviceAreaId && filters.serviceAreaId !== 'all') {
        query = query.eq('service_area_id', filters.serviceAreaId);
      }
      if (filters?.dateFrom) {
        query = query.gte('created_at', filters.dateFrom);
      }
      if (filters?.dateTo) {
        query = query.lte('created_at', filters.dateTo);
      }
      if (filters?.search) {
        query = query.or(
          `case_number.ilike.%${filters.search}%,item_description.ilike.%${filters.search}%,trip_id.eq.${isUUID(filters.search) ? filters.search : '00000000-0000-0000-0000-000000000000'}`
        );
      }

      const { data, error } = await query;
      if (error) throw error;
      return enrichCasesWithNames((data ?? []) as LostPropertyCase[]);
    },
    staleTime: 15_000,
  });
}

export function useLostPropertyCase(caseId: string | undefined) {
  return useQuery({
    queryKey: ['lost-property-case', caseId],
    queryFn: async () => {
      if (!caseId) return null;
      const { data, error } = await supabase
        .from('lost_property_cases')
        .select('*')
        .eq('id', caseId)
        .single();
      if (error) throw error;
      const enriched = await enrichCasesWithNames([data as LostPropertyCase]);
      return enriched[0];
    },
    enabled: !!caseId,
    staleTime: 10_000,
  });
}

export function useTripSummary(tripId: string | undefined) {
  return useQuery({
    queryKey: ['trip-summary', tripId],
    queryFn: async () => {
      if (!tripId) return null;
      const { data, error } = await supabase
        .from('trips')
        .select('id, pickup_address, dropoff_address, started_at, completed_at, created_at')
        .eq('id', tripId)
        .single();
      if (error) throw error;
      return data as TripSummary;
    },
    enabled: !!tripId,
    staleTime: 60_000,
  });
}

export function useLostPropertyMessages(caseId: string | undefined) {
  return useQuery({
    queryKey: ['lost-property-messages', caseId],
    queryFn: async () => {
      if (!caseId) return [];
      const { data, error } = await supabase
        .from('lost_property_messages')
        .select('*')
        .eq('case_id', caseId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as LostPropertyMessage[];
    },
    enabled: !!caseId,
    staleTime: 5_000,
  });
}

export function useLostPropertyUnreadCount() {
  const [count, setCount] = useState(0);

  const fetchCount = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('lost_property_admin_unread_count');
      if (!error && data !== null) {
        setCount(typeof data === 'number' ? data : 0);
      }
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    fetchCount();
  }, [fetchCount]);

  useEffect(() => {
    const channel = supabase
      .channel('lp-unread')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lost_property_cases' }, () => fetchCount())
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'lost_property_messages' }, () => fetchCount())
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [fetchCount]);

  return count;
}

export function useLostPropertyActions() {
  const queryClient = useQueryClient();

  const invokeAction = async (action: string, body: Record<string, unknown>) => {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/lost-property?action=${action}`;
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify(body),
    });

    const result = await resp.json();
    if (!resp.ok || !result.success) {
      throw new Error(result.error || 'Action failed');
    }
    return result;
  };

  const invalidateAll = (caseId?: string) => {
    queryClient.invalidateQueries({ queryKey: ['lost-property-cases'] });
    if (caseId) {
      queryClient.invalidateQueries({ queryKey: ['lost-property-case', caseId] });
      queryClient.invalidateQueries({ queryKey: ['lost-property-messages', caseId] });
    }
  };

  const adminCloseCase = useMutation({
    mutationFn: (case_id: string) => invokeAction('admin_close_case', { case_id }),
    onSuccess: (_, case_id) => invalidateAll(case_id),
  });

  const adminOpenCase = useMutation({
    mutationFn: (case_id: string) => invokeAction('admin_open_case', { case_id }),
    onSuccess: (_, case_id) => invalidateAll(case_id),
  });

  const adminReopenCase = useMutation({
    mutationFn: (case_id: string) => invokeAction('admin_reopen_case', { case_id }),
    onSuccess: (_, case_id) => invalidateAll(case_id),
  });

  const adminEscalateCase = useMutation({
    mutationFn: (case_id: string) => invokeAction('admin_escalate_case', { case_id }),
    onSuccess: (_, case_id) => invalidateAll(case_id),
  });

  const adminLockChat = useMutation({
    mutationFn: (case_id: string) => invokeAction('admin_lock_chat', { case_id }),
    onSuccess: (_, case_id) => invalidateAll(case_id),
  });

  const adminUnlockChat = useMutation({
    mutationFn: (case_id: string) => invokeAction('admin_unlock_chat', { case_id }),
    onSuccess: (_, case_id) => invalidateAll(case_id),
  });

  const adminSendMessage = useMutation({
    mutationFn: ({ case_id, message }: { case_id: string; message: string }) =>
      invokeAction('admin_send_message', { case_id, message }),
    onSuccess: (_, { case_id }) => invalidateAll(case_id),
  });

  const adminMarkViewed = useMutation({
    mutationFn: (case_id: string) => invokeAction('admin_mark_viewed', { case_id }),
    onSuccess: (_, case_id) => invalidateAll(case_id),
  });

  return {
    adminCloseCase,
    adminOpenCase,
    adminReopenCase,
    adminEscalateCase,
    adminLockChat,
    adminUnlockChat,
    adminSendMessage,
    adminMarkViewed,
  };
}

export function useLostPropertyRealtime(caseId: string | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!caseId) return;

    const channel = supabase
      .channel(`lp-case-${caseId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'lost_property_cases', filter: `id=eq.${caseId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['lost-property-case', caseId] });
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'lost_property_messages', filter: `case_id=eq.${caseId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['lost-property-messages', caseId] });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [caseId, queryClient]);
}

function isUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
