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
  show_in_driver_app: boolean;
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
        .select(
          "id, name, slug, description, is_required, has_expiry, show_in_driver_app, reminder_days_before_expiry, display_order, is_active, created_at, updated_at",
        )
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
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        throw new Error(
          "Update blocked — your admin session cannot modify document types (FORBIDDEN / RLS).",
        );
      }
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

/**
 * Remove a document type.
 * - Unused types (no driver document rows): hard delete.
 * - Types already uploaded by drivers: soft-deactivate (is_active=false)
 *   because documents.document_type_id FK is NO ACTION.
 */
export function useDeleteDocumentType() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { data: typeRow, error: typeErr } = await supabase
        .from("document_types")
        .select("id, slug, name")
        .eq("id", id)
        .maybeSingle();
      if (typeErr) throw typeErr;
      if (!typeRow) throw new Error("Document type not found.");

      const [{ count: byIdCount, error: byIdErr }, { count: bySlugCount, error: bySlugErr }] =
        await Promise.all([
          supabase
            .from("documents")
            .select("id", { count: "exact", head: true })
            .eq("document_type_id", id),
          supabase
            .from("documents")
            .select("id", { count: "exact", head: true })
            .eq("document_type", typeRow.slug),
        ]);
      if (byIdErr) throw byIdErr;
      if (bySlugErr) throw bySlugErr;

      const inUse = (byIdCount ?? 0) + (bySlugCount ?? 0) > 0;
      if (inUse) {
        const { data, error } = await supabase
          .from("document_types")
          .update({
            is_active: false,
            show_in_driver_app: false,
          })
          .eq("id", id)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          throw new Error(
            "Deactivate blocked — your admin session cannot modify document types.",
          );
        }
        await supabase
          .from("service_area_document_rules")
          .update({ is_active: false, display_in_driver_app: false })
          .eq("doc_type_id", id);
        return { mode: "deactivated" as const, name: typeRow.name };
      }

      const { error } = await supabase.from("document_types").delete().eq("id", id);
      if (error) {
        // FK / RLS surfaces as FORBIDDEN or foreign key violation
        throw new Error(
          error.message === "FORBIDDEN"
            ? "Delete blocked by server policy. Try again after refreshing Admin."
            : error.message,
        );
      }
      return { mode: "deleted" as const, name: typeRow.name };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
      toast.success(
        result.mode === "deleted"
          ? `"${result.name}" deleted`
          : `"${result.name}" deactivated (drivers already uploaded this type)`,
      );
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to delete document type");
    },
  });
}
