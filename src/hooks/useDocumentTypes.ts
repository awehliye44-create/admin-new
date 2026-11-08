import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  adminDocumentTypeInUse,
  adminPageMutate,
  adminPageSelect,
} from "@/lib/adminPageGatedData";
import { toast } from "sonner";

const PAGE = "document-management" as const;

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
      const { rows } = await adminPageSelect<DocumentType>(PAGE, "document_types", {
        columns: [
          "id",
          "name",
          "slug",
          "description",
          "is_required",
          "has_expiry",
          "show_in_driver_app",
          "reminder_days_before_expiry",
          "display_order",
          "is_active",
          "created_at",
          "updated_at",
        ],
        order: [{ col: "display_order", asc: true }],
        limit: 500,
      });
      return rows;
    },
  });
}

export function useUpdateDocumentType() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (updates: Partial<DocumentType> & { id: string }) => {
      const { id, ...rest } = updates;
      const { row } = await adminPageMutate<DocumentType>(PAGE, "document_types", "update", {
        id,
        patch: rest as Record<string, unknown>,
      });
      if (!row) {
        throw new Error(
          "Update blocked — your admin session cannot modify document types (FORBIDDEN / page grant).",
        );
      }
      return row;
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
      const { row } = await adminPageMutate<DocumentType>(PAGE, "document_types", "insert", {
        patch: docType as Record<string, unknown>,
      });
      if (!row) throw new Error("Create blocked — missing document-management page access.");
      return row;
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
      const { rows } = await adminPageSelect<Pick<DocumentType, "id" | "slug" | "name">>(
        PAGE,
        "document_types",
        {
          columns: ["id", "slug", "name"],
          filters: [{ op: "eq", col: "id", val: id }],
          limit: 1,
        },
      );
      const typeRow = rows[0];
      if (!typeRow) throw new Error("Document type not found.");

      // Page: document-management. Narrow DEFINER RPC — does not weaken documents Owner-only RLS.
      const inUse = await adminDocumentTypeInUse(id);
      if (inUse) {
        const { row } = await adminPageMutate(PAGE, "document_types", "update", {
          id,
          patch: { is_active: false, show_in_driver_app: false },
        });
        if (!row) {
          throw new Error(
            "Deactivate blocked — your admin session cannot modify document types.",
          );
        }
        await adminPageMutate(PAGE, "service_area_document_rules", "update", {
          filters: [{ op: "eq", col: "doc_type_id", val: id }],
          patch: { is_active: false, display_in_driver_app: false },
        });
        return { mode: "deactivated" as const, name: typeRow.name };
      }

      const { deleted } = await adminPageMutate(PAGE, "document_types", "delete", {
        ids: [id],
      });
      if (!deleted) {
        throw new Error("Delete blocked by server policy. Try again after refreshing Admin.");
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
