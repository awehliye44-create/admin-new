import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";

export interface OnecabDocument {
  id: string;
  title: string;
  category: string;
  document_type: string | null;
  issuing_authority: string | null;
  description: string | null;
  reference_number: string | null;
  issue_date: string | null;
  expiry_date: string | null;
  reminder_days_before: number;
  renewal_status: string;
  status: string;
  file_name: string | null;
  file_path: string | null;
  mime_type: string | null;
  notes: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface OnecabDocumentInsert {
  title: string;
  category: string;
  document_type?: string;
  issuing_authority?: string;
  description?: string;
  reference_number?: string;
  issue_date?: string;
  expiry_date?: string;
  reminder_days_before?: number;
  renewal_status?: string;
  status?: string;
  file_name?: string;
  file_path?: string;
  mime_type?: string;
  notes?: string;
}

export type EscalationLevel = "safe" | "preparation" | "warning" | "critical" | "urgent" | "expired" | "no_expiry" | "archived";

export function getEscalationLevel(doc: OnecabDocument): EscalationLevel {
  if (doc.status === "archived") return "archived";
  if (!doc.expiry_date) return "no_expiry";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(doc.expiry_date);
  expiry.setHours(0, 0, 0, 0);
  const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (daysLeft < 0) return "expired";
  if (daysLeft <= 7) return "urgent";
  if (daysLeft <= 14) return "critical";
  if (daysLeft <= 30) return "warning";
  if (daysLeft <= 60) return "preparation";
  return "safe";
}

export function getDaysLeft(doc: OnecabDocument): number | null {
  if (!doc.expiry_date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(doc.expiry_date);
  expiry.setHours(0, 0, 0, 0);
  return Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export function getExpiryStatus(doc: OnecabDocument): string {
  if (doc.status === "archived") return "Archived";
  if (!doc.expiry_date) return "No Expiry";
  const days = getDaysLeft(doc)!;
  if (days < 0) return "Expired";
  if (days <= doc.reminder_days_before) return "Expiring Soon";
  return "Active";
}

export function useOnecabDocuments() {
  return useQuery({
    queryKey: ["onecab-documents"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("onecab_documents")
        .select("*")
        .is("deleted_at", null)
        .order("expiry_date", { ascending: true, nullsFirst: false });

      if (error) throw error;
      return (data || []) as OnecabDocument[];
    },
  });
}

export function useOnecabDocumentActivity(documentId?: string) {
  return useQuery({
    queryKey: ["onecab-document-activity", documentId],
    queryFn: async () => {
      let query = supabase
        .from("onecab_document_activity_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (documentId) {
        query = query.eq("document_id", documentId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
  });
}

export function useCreateOnecabDocument() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (input: OnecabDocumentInsert) => {
      const { data, error } = await supabase
        .from("onecab_documents")
        .insert({ ...input, uploaded_by: user?.id })
        .select()
        .single();

      if (error) throw error;

      // Log activity
      await supabase.from("onecab_document_activity_log").insert({
        document_id: data.id,
        action: "Created",
        details: `Created document: ${input.title}`,
        performed_by: user?.id,
      });

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["onecab-documents"] });
      queryClient.invalidateQueries({ queryKey: ["onecab-document-activity"] });
      toast.success("Document created successfully");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useUpdateOnecabDocument() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<OnecabDocument> & { id: string }) => {
      const { data, error } = await supabase
        .from("onecab_documents")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;

      const changeDetails = Object.keys(updates).join(", ");
      await supabase.from("onecab_document_activity_log").insert({
        document_id: id,
        action: "Updated",
        details: `Updated fields: ${changeDetails}`,
        performed_by: user?.id,
      });

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["onecab-documents"] });
      queryClient.invalidateQueries({ queryKey: ["onecab-document-activity"] });
      toast.success("Document updated");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeleteOnecabDocument() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("onecab_documents")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw error;

      await supabase.from("onecab_document_activity_log").insert({
        document_id: id,
        action: "Archived",
        details: "Document soft-deleted",
        performed_by: user?.id,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["onecab-documents"] });
      queryClient.invalidateQueries({ queryKey: ["onecab-document-activity"] });
      toast.success("Document archived");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useUploadOnecabFile() {
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ file, documentId }: { file: File; documentId: string }) => {
      const ext = file.name.split(".").pop();
      const path = `${documentId}/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("onecab-documents")
        .upload(path, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from("onecab_documents")
        .update({
          file_name: file.name,
          file_path: path,
          mime_type: file.type,
        })
        .eq("id", documentId);

      if (updateError) throw updateError;

      await supabase.from("onecab_document_activity_log").insert({
        document_id: documentId,
        action: "File Uploaded",
        details: `Uploaded file: ${file.name}`,
        performed_by: user?.id,
      });

      return path;
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
