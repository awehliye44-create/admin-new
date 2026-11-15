-- Soft rollback for Bug #22 marketplace status stamp.
-- Restores status=offered for non-urgent compliance release (pre-Bug #22).
-- Prefer re-applying 20270224120000 function body if a full revert is required.

COMMENT ON FUNCTION public.release_scheduled_assignment_for_compliance(uuid, uuid, text, boolean) IS
  'Release unactivated confirmed scheduled assignment (compliance). Soft-rollback note: Bug #22 status=scheduled patch may still be live until 20270224120000 is reapplied.';
