import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface DocumentType {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_required: boolean;
  has_expiry: boolean;
  reminder_days_before_expiry: number[];
  display_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export function useDocumentTypes() {
  return useQuery({
    queryKey: ["document-types"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_types")
        .select("*")
        .order("display_order", { ascending: true });

      if (error) throw error;
      return data as DocumentType[];
    },
  });
}

export function useUpdateDocumentType() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (updates: Partial<DocumentType> & { id: string }) => {
      const { id, ...rest } = updates;
      const { data, error } = await supabase
        .from("document_types")
        .update(rest)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
      toast.success("Document type updated");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update document type");
    },
  });
}

export function useCreateDocumentType() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (docType: Omit<DocumentType, "id" | "created_at" | "updated_at">) => {
      const { data, error } = await supabase
        .from("document_types")
        .insert(docType)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
      toast.success("Document type created");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to create document type");
    },
  });
}

export function useDeleteDocumentType() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("document_types")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
      toast.success("Document type deleted");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to delete document type");
    },
  });
}
