# Driver App patch — consume `driver_document_compliance_ssot`

Apply these edits **in the ONECAB Driver repo** (project id `2543afda-4c39-4e1e-a8c5-7385d68e9452`). Lovable cross-project access is read-only, so this must be pasted in there by the owner. All legacy client-side expiry math must be **deleted**, not commented out.

---

## 1. New hook — `src/hooks/useDriverDocumentCompliance.ts`

```ts
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export type ExpiryStatus =
  | "missing" | "pending" | "approved_valid"
  | "expiring_soon" | "expired" | "rejected" | "superseded";

export interface DriverDocumentComplianceRow {
  driver_id: string;
  document_type_id: string;
  document_type_key: string;
  display_name: string;
  is_required: boolean;
  has_expiry: boolean;
  document_id: string | null;
  approval_status: string | null;
  expiry_date: string | null;
  file_url: string | null;
  last_updated_at: string | null;
  replacement_document_id: string | null;
  is_current: boolean;
  is_superseded: boolean;
  expiry_status: ExpiryStatus;
  days_until_expiry: number | null;
  blocks_online: boolean;
}

export function useDriverDocumentCompliance() {
  const [rows, setRows] = useState<DriverDocumentComplianceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("get_driver_document_compliance");
    if (error) setError(error.message);
    else setRows((data ?? []) as DriverDocumentComplianceRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Refresh on foreground/resume
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  return { rows, loading, error, refresh };
}
```

## 2. Rewrite `src/components/DocumentUpload.tsx`

Replace the merge/isExpired logic. **Delete** every `new Date(x) < new Date()` comparison.

```tsx
// Replace lines ~46–146 (state + fetchDriverAndDocuments) with:
import { useDriverDocumentCompliance, DriverDocumentComplianceRow, ExpiryStatus }
  from "@/hooks/useDriverDocumentCompliance";

const { rows, loading: isLoading, refresh } = useDriverDocumentCompliance();
// remove: documents, fetchDriverAndDocuments, isExpired, expiryDates fetch merge
```

Icon + badge come from `expiry_status`:

```tsx
function statusIcon(row: DriverDocumentComplianceRow) {
  switch (row.expiry_status) {
    case "approved_valid": return <Check className="w-5 h-5 text-green-500" />;
    case "expiring_soon":  return <AlertTriangle className="w-5 h-5 text-orange-400" />;
    case "expired":        return <AlertCircle className="w-5 h-5 text-red-500" />;
    case "rejected":       return <AlertCircle className="w-5 h-5 text-red-500" />;
    case "pending":        return <Clock className="w-5 h-5 text-yellow-500" />;
    default:               return <Upload className="w-5 h-5 text-zinc-500" />;
  }
}

function statusBadge(row: DriverDocumentComplianceRow) {
  const days = row.days_until_expiry;
  switch (row.expiry_status) {
    case "expired":
      return <Badge red>Expired{days != null ? ` ${Math.abs(days)}d ago` : ""}</Badge>;
    case "expiring_soon":
      return <Badge orange>Expiring{days != null ? ` in ${days}d` : ""}</Badge>;
    case "rejected":       return <Badge red>Rejected</Badge>;
    case "pending":        return <Badge yellow>Pending review</Badge>;
    case "missing":        return <Badge zinc>Not uploaded</Badge>;
    case "approved_valid": return <Badge green>Approved</Badge>;
    case "superseded":     return <Badge zinc>Replaced</Badge>;
  }
}
```

Stats must derive from `expiry_status` — approved excludes expired:

```tsx
const stats = {
  approved:   rows.filter(r => r.expiry_status === "approved_valid").length,
  expiring:   rows.filter(r => r.expiry_status === "expiring_soon").length,
  expired:    rows.filter(r => r.expiry_status === "expired").length,
  pending:    rows.filter(r => r.expiry_status === "pending").length,
  missing:    rows.filter(r => r.expiry_status === "missing").length,
};
// Render an Expired card in the stats grid alongside Approved/Pending.
```

List order (Expired → Rejected → Missing → Expiring soon → Pending → Valid) is already applied server-side by the RPC — iterate `rows` directly.

Re-upload UI shows when `expiry_status ∈ {missing, rejected, expired}`:

```tsx
const canRenew = ["missing","rejected","expired"].includes(row.expiry_status);
```

Call `refresh()` after every successful upload/delete instead of the old `fetchDriverAndDocuments()`.

## 3. Replace `src/hooks/useDriverApproval.ts` expiry loop

Delete the entire `documents` fetch + `new Date()` loop. Consume the SSOT:

```ts
const { rows } = useDriverDocumentCompliance();
const blocksOnline = rows.some(r => r.blocks_online);
const issues = rows.filter(r => r.expiry_status !== "approved_valid");
```

`can_go_online` = `!blocksOnline` (plus any other business gates already there).

## 4. Delete `useDocumentTypes` fallback branch

`useDocumentTypes` may stay for the upload form (labels, `has_expiry`), but **remove any code that treats a missing SSOT row as compliant**. The SSOT is authoritative for status.

## 5. Auth behaviour

Do **not** sign the driver out when documents are expired. Show the SSOT-driven blocking banner and disable GO Online only.

## Verification checklist after applying

- Ahmed Osman screen shows PHV (Expiring in 7d), DVLA (Approved), PHD (Expiring in 2d) — same as Admin.
- Any test driver with an expired required doc sees a red badge and cannot go online.
- Reopening the app / tab focus refreshes compliance (no stale green ✓).
