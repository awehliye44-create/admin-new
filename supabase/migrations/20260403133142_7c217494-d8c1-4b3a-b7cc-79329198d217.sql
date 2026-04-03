-- Fix all NO ACTION foreign keys to auth.users → SET NULL
-- These are audit/tracking columns that should not block user deletion

ALTER TABLE payout_batches DROP CONSTRAINT payout_batches_created_by_fkey,
  ADD CONSTRAINT payout_batches_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE corporate_locations DROP CONSTRAINT corporate_locations_created_by_fkey,
  ADD CONSTRAINT corporate_locations_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE corporate_support_tickets DROP CONSTRAINT corporate_support_tickets_created_by_fkey,
  ADD CONSTRAINT corporate_support_tickets_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE corporate_ticket_messages DROP CONSTRAINT corporate_ticket_messages_sender_id_fkey,
  ADD CONSTRAINT corporate_ticket_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE corporate_audit_log DROP CONSTRAINT corporate_audit_log_user_id_fkey,
  ADD CONSTRAINT corporate_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE content_items DROP CONSTRAINT content_items_published_by_fkey,
  ADD CONSTRAINT content_items_published_by_fkey FOREIGN KEY (published_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE content_items DROP CONSTRAINT content_items_updated_by_fkey,
  ADD CONSTRAINT content_items_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE content_audit_log DROP CONSTRAINT content_audit_log_user_id_fkey,
  ADD CONSTRAINT content_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE onecab_documents DROP CONSTRAINT onecab_documents_uploaded_by_fkey,
  ADD CONSTRAINT onecab_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE onecab_document_activity_log DROP CONSTRAINT onecab_document_activity_log_performed_by_fkey,
  ADD CONSTRAINT onecab_document_activity_log_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE account_suspensions DROP CONSTRAINT account_suspensions_suspended_by_fkey,
  ADD CONSTRAINT account_suspensions_suspended_by_fkey FOREIGN KEY (suspended_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE account_suspensions DROP CONSTRAINT account_suspensions_lifted_by_fkey,
  ADD CONSTRAINT account_suspensions_lifted_by_fkey FOREIGN KEY (lifted_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE qr_booking_config DROP CONSTRAINT qr_booking_config_updated_by_fkey,
  ADD CONSTRAINT qr_booking_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE qr_booking_audit_log DROP CONSTRAINT qr_booking_audit_log_changed_by_fkey,
  ADD CONSTRAINT qr_booking_audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE invoice_templates DROP CONSTRAINT invoice_templates_created_by_fkey,
  ADD CONSTRAINT invoice_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE statement_runs DROP CONSTRAINT statement_runs_created_by_fkey,
  ADD CONSTRAINT statement_runs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE invoices DROP CONSTRAINT invoices_sent_by_fkey,
  ADD CONSTRAINT invoices_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE invoice_delivery_logs DROP CONSTRAINT invoice_delivery_logs_sent_by_fkey,
  ADD CONSTRAINT invoice_delivery_logs_sent_by_fkey FOREIGN KEY (sent_by) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE ops_fix_actions DROP CONSTRAINT ops_fix_actions_executed_by_fkey,
  ADD CONSTRAINT ops_fix_actions_executed_by_fkey FOREIGN KEY (executed_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Also fix the NOT NULL constraints on columns that need to allow NULL after user deletion
ALTER TABLE corporate_support_tickets ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE corporate_ticket_messages ALTER COLUMN sender_id DROP NOT NULL;