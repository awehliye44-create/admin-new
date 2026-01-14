import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { addDays, isPast, isBefore } from "date-fns";

export interface ExpiringDocument {
  id: string;
  driver_id: string;
  document_type: string;
  document_name: string;
  expiry_date: string;
  status: string;
  days_until_expiry: number;
  driver?: {
    id: string;
    first_name: string;
    last_name: string;
    phone: string;
    email: string;
  };
  document_type_info?: {
    id: string;
    name: string;
    has_expiry: boolean;
  };
}

export function useExpiringDocuments(daysAhead: number = 30) {
  return useQuery({
    queryKey: ["expiring-documents", daysAhead],
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const futureDate = addDays(today, daysAhead);

      const { data, error } = await supabase
        .from("documents")
        .select(`
          id,
          driver_id,
          document_type,
          document_name,
          expiry_date,
          status,
          driver:drivers(id, first_name, last_name, phone, email),
          document_type_info:document_types(id, name, has_expiry)
        `)
        .eq("status", "approved")
        .not("expiry_date", "is", null)
        .gte("expiry_date", today.toISOString().split("T")[0])
        .lte("expiry_date", futureDate.toISOString().split("T")[0])
        .order("expiry_date", { ascending: true });

      if (error) throw error;

      return (data || []).map((doc) => {
        const expiryDate = new Date(doc.expiry_date!);
        const daysUntilExpiry = Math.ceil(
          (expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
        );
        return {
          ...doc,
          days_until_expiry: daysUntilExpiry,
        } as ExpiringDocument;
      });
    },
  });
}

export function useExpiredDocuments() {
  return useQuery({
    queryKey: ["expired-documents"],
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const { data, error } = await supabase
        .from("documents")
        .select(`
          id,
          driver_id,
          document_type,
          document_name,
          expiry_date,
          status,
          driver:drivers(id, first_name, last_name, phone, email),
          document_type_info:document_types(id, name, has_expiry)
        `)
        .eq("status", "approved")
        .not("expiry_date", "is", null)
        .lt("expiry_date", today.toISOString().split("T")[0])
        .order("expiry_date", { ascending: false });

      if (error) throw error;

      return (data || []).map((doc) => {
        const expiryDate = new Date(doc.expiry_date!);
        const daysExpiredAgo = Math.ceil(
          (today.getTime() - expiryDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        return {
          ...doc,
          days_until_expiry: -daysExpiredAgo,
        } as ExpiringDocument;
      });
    },
  });
}

export function useDocumentExpiryStats() {
  return useQuery({
    queryKey: ["document-expiry-stats"],
    queryFn: async () => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sevenDays = addDays(today, 7);
      const thirtyDays = addDays(today, 30);

      const { data, error } = await supabase
        .from("documents")
        .select("id, expiry_date, status")
        .eq("status", "approved")
        .not("expiry_date", "is", null);

      if (error) throw error;

      let expiredCount = 0;
      let expiringIn7Days = 0;
      let expiringIn30Days = 0;

      (data || []).forEach((doc) => {
        const expiry = new Date(doc.expiry_date!);
        if (isPast(expiry)) {
          expiredCount++;
        } else if (isBefore(expiry, sevenDays)) {
          expiringIn7Days++;
        } else if (isBefore(expiry, thirtyDays)) {
          expiringIn30Days++;
        }
      });

      return {
        expired: expiredCount,
        expiringIn7Days,
        expiringIn30Days,
        total: data?.length || 0,
      };
    },
  });
}
