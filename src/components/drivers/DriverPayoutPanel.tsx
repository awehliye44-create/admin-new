import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { CreditCard, History, MapPin } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

type DriverPayoutPanelProps = {
  driverId: string;
  serviceAreaId?: string | null;
  regionId?: string | null;
  stripeAccountId?: string | null;
  payoutsEnabled?: boolean | null;
  onboardingComplete?: boolean | null;
  chargesEnabled?: boolean | null;
};

type DestinationRow = {
  id?: string;
  provider?: string;
  destination_type?: string | null;
  destination_label?: string | null;
  destination_last4?: string | null;
  masked_sort_code?: string | null;
  masked_account_number?: string | null;
  account_holder_name?: string | null;
  verification_status?: string | null;
  provider_counterparty_id?: string | null;
  provider_recipient_account_id?: string | null;
  provider_link_status?: string | null;
  provider_sync_status?: string | null;
  provider_synced_at?: string | null;
  provider_last_checked_at?: string | null;
  provider_error_code?: string | null;
  provider_error_message_safe?: string | null;
  is_active?: boolean | null;
  updated_at?: string | null;
};

export function DriverPayoutPanel({
  driverId,
  serviceAreaId,
  regionId,
  stripeAccountId,
  payoutsEnabled,
  onboardingComplete,
  chargesEnabled,
}: DriverPayoutPanelProps) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["driver-payout-panel", driverId],
    queryFn: async () => {
      const { data: dsaRow } = await supabase
        .from("driver_service_areas")
        .select("service_area_id")
        .eq("driver_id", driverId)
        .limit(1)
        .maybeSingle();

      const resolvedServiceAreaId = serviceAreaId ?? dsaRow?.service_area_id ?? null;

      const [areaRes, regionRes, destinationRes, auditRes] = await Promise.all([
        resolvedServiceAreaId
          ? supabase
            .from("service_areas")
            .select("name, payment_provider, driver_payout_gateway, customer_payment_gateway")
            .eq("id", resolvedServiceAreaId)
            .maybeSingle()
          : Promise.resolve({ data: null }),
        regionId
          ? supabase
            .from("regions")
            .select("name, currency_code, distance_unit")
            .eq("id", regionId)
            .maybeSingle()
          : Promise.resolve({ data: null }),
        supabase
          .from("driver_payout_destinations")
          .select(
            "id, provider, destination_type, destination_label, destination_last4, masked_sort_code, masked_account_number, account_holder_name, verification_status, provider_counterparty_id, provider_recipient_account_id, provider_link_status, provider_sync_status, provider_synced_at, provider_last_checked_at, provider_error_code, provider_error_message_safe, is_active, updated_at",
          )
          .eq("driver_id", driverId)
          .eq("is_active", true)
          .is("archived_at", null),
        supabase
          .from("driver_payout_destination_audit")
          .select(
            "id, provider, action, destination_type, changed_by_role, created_at, new_payload, previous_payload",
          )
          .eq("driver_id", driverId)
          .order("created_at", { ascending: false })
          .limit(8),
      ]);

      return {
        serviceArea: areaRes.data,
        region: regionRes.data,
        destinations: destinationRes.data ?? [],
        audit: auditRes.data ?? [],
      };
    },
    enabled: Boolean(driverId),
  });

  const adminAction = useMutation({
    mutationFn: async (action: "verify" | "reject" | "disable") => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error("Admin session required");

      const destination = (data?.destinations as DestinationRow[] | undefined)?.[0];
      const res = await supabase.functions.invoke("admin-verify-driver-payout-destination", {
        body: {
          action,
          driver_id: driverId,
          destination_id: destination?.id,
        },
      });
      if (res.error) throw res.error;
      if (res.data?.success !== true) {
        throw new Error(res.data?.error ?? "Admin action failed");
      }
      return res.data;
    },
    onSuccess: (_result, action) => {
      toast.success(
        action === "verify"
          ? "Destination verified (MANUAL_VERIFIED)"
          : action === "reject"
          ? "Destination rejected"
          : "Destination disabled",
      );
      void queryClient.invalidateQueries({ queryKey: ["driver-payout-panel", driverId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Admin action failed");
    },
  });

  const syncProvider = useMutation({
    mutationFn: async () => {
      const res = await supabase.functions.invoke("admin-sync-driver-payout-provider-linkage", {
        body: { driver_ids: [driverId] },
      });
      if (res.error) throw res.error;
      if (res.data?.success !== true) {
        throw new Error(res.data?.error ?? "Provider sync failed");
      }
      return res.data;
    },
    onSuccess: (result) => {
      const row = Array.isArray(result?.results) ? result.results[0] : null;
      const status = row?.provider_link_status ?? result?.verdict ?? "updated";
      toast.message("Provider sync finished", {
        description: String(status),
      });
      void queryClient.invalidateQueries({ queryKey: ["driver-payout-panel", driverId] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Provider sync failed");
    },
  });

  const serviceArea = data?.serviceArea as {
    name?: string | null;
    payment_provider?: string | null;
    driver_payout_gateway?: string | null;
    customer_payment_gateway?: string | null;
  } | null | undefined;
  const payoutGatewayRaw =
    serviceArea?.driver_payout_gateway ??
    serviceArea?.payment_provider ??
    serviceArea?.customer_payment_gateway ??
    null;
  const payoutGateway = String(payoutGatewayRaw ?? "").toLowerCase() === "stripe"
    ? "revolut"
    : (payoutGatewayRaw ?? "revolut");
  const usesStripe = false; // Stripe Connect payouts retired from active finance
  const region = data?.region;
  const destinations = (data?.destinations ?? []) as DestinationRow[];
  const destination = destinations.find((row) => row.provider === payoutGateway) ?? destinations[0] ?? null;
  const staleOtherProvider = destinations.find((row) => row.provider && row.provider !== payoutGateway) ?? null;
  const providerMismatch = Boolean(!usesStripe && !destination && staleOtherProvider);
  const verificationStatus = String(destination?.verification_status ?? "").toUpperCase() || null;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading payout settings…</p>;
  }

  return (
    <div className="p-4 border rounded-lg space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CreditCard className="h-5 w-5 text-muted-foreground" />
          <h4 className="text-sm font-medium">Payout</h4>
        </div>
        <Badge variant="outline">{payoutGateway.replace(/_/g, " ")}</Badge>
      </div>

      <div className="grid gap-2 text-sm md:grid-cols-2">
        <div className="p-2 bg-muted/50 rounded">
          <p className="text-xs text-muted-foreground">Service Area</p>
          <p>{data?.serviceArea?.name ?? "—"}</p>
        </div>
        <div className="p-2 bg-muted/50 rounded">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <MapPin className="h-3 w-3" /> Region
          </p>
          <p>
            {region?.name ?? "—"}
            {region?.currency_code ? ` · ${region.currency_code}` : ""}
            {region?.distance_unit ? ` · ${region.distance_unit}` : ""}
          </p>
        </div>
      </div>

      {providerMismatch ? (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Provider mismatch: driver has an active destination for {String(staleOtherProvider?.provider).replace(/_/g, " ")}, but
          this service area uses {payoutGateway.replace(/_/g, " ")}. Payout is blocked until a {payoutGateway.replace(/_/g, " ")} destination is added.
        </p>
      ) : null}

      {usesStripe ? (
        <div className="space-y-2 text-sm">
          <p className="font-medium">Provider</p>
          {stripeAccountId ? (
            <div className="grid grid-cols-2 gap-2">
              <div className="p-2 bg-muted/50 rounded">
                <p className="text-xs text-muted-foreground">Account ID</p>
                <p className="font-mono text-xs break-all">{stripeAccountId}</p>
              </div>
              <div className="p-2 bg-muted/50 rounded">
                <p className="text-xs text-muted-foreground">Status</p>
                <p>
                  {onboardingComplete && payoutsEnabled
                    ? "Connected"
                    : chargesEnabled || onboardingComplete
                    ? "Restricted"
                    : "Not Connected"}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">Driver has not connected Provider.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p className="font-medium">Payout Destination</p>
          {destination ? (
            <div className="p-2 bg-muted/50 rounded space-y-1">
              <p>
                <span className="text-muted-foreground">Type:</span>{" "}
                {destination.destination_type?.replace(/_/g, " ")}
              </p>
              <p>
                <span className="text-muted-foreground">Masked:</span>{" "}
                {destination.destination_label
                  ?? destination.masked_account_number
                  ?? `****${destination.destination_last4 ?? ""}`}
              </p>
              {destination.masked_sort_code ? (
                <p>
                  <span className="text-muted-foreground">Sort code:</span>{" "}
                  {destination.masked_sort_code}
                </p>
              ) : null}
              <p>
                <span className="text-muted-foreground">Status:</span>{" "}
                {verificationStatus ?? "PENDING_VERIFICATION"}
              </p>
              <div className="pt-1 space-y-0.5 text-xs">
                <p>Destination saved: Yes</p>
                <p>
                  Manual verification:{" "}
                  {verificationStatus === "MANUAL_VERIFIED" || verificationStatus === "PROVIDER_VERIFIED"
                    ? "Verified"
                    : "Pending"}
                </p>
                <p>
                  Revolut counterparty:{" "}
                  {destination.provider_counterparty_id ? "Linked" : "Not linked"}
                </p>
                <p>
                  Recipient account:{" "}
                  {destination.provider_recipient_account_id ? "Linked" : "Not linked"}
                </p>
                <p>
                  Provider readiness:{" "}
                  {destination.provider_link_status === "PROVIDER_VERIFIED"
                    ? "Ready"
                    : destination.provider_link_status === "BLOCKED_BY_OAUTH_SCOPE"
                    ? "Blocked — OAuth WRITE required"
                    : destination.provider_link_status === "CONFLICT"
                    ? "Conflict — review required"
                    : (destination.provider_link_status ?? "Not linked")}
                </p>
                {destination.provider_last_checked_at ? (
                  <p className="text-muted-foreground">
                    Last provider sync{" "}
                    {format(new Date(destination.provider_last_checked_at), "MMM d, yyyy HH:mm")}
                  </p>
                ) : null}
                {destination.provider_error_code ? (
                  <p className="text-amber-700">
                    Safe error: {destination.provider_error_code}
                    {destination.provider_error_message_safe
                      ? ` — ${destination.provider_error_message_safe}`
                      : ""}
                  </p>
                ) : null}
              </div>
              {destination.updated_at ? (
                <p className="text-xs text-muted-foreground">
                  Last changed {format(new Date(destination.updated_at), "MMM d, yyyy HH:mm")}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2 pt-2">
                <Button
                  size="sm"
                  disabled={adminAction.isPending || verificationStatus === "MANUAL_VERIFIED"}
                  onClick={() => adminAction.mutate("verify")}
                >
                  Verify destination
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={adminAction.isPending || verificationStatus === "REJECTED"}
                  onClick={() => adminAction.mutate("reject")}
                >
                  Reject destination
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={adminAction.isPending || verificationStatus === "DISABLED"}
                  onClick={() => adminAction.mutate("disable")}
                >
                  Disable destination
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={syncProvider.isPending}
                  onClick={() => syncProvider.mutate()}
                >
                  Sync with Revolut
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={syncProvider.isPending}
                  onClick={() => syncProvider.mutate()}
                >
                  Retry provider linkage
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={destination.provider_link_status !== "CONFLICT"}
                  onClick={() => {
                    toast.message("Review conflict", {
                      description:
                        "Multiple Revolut counterparties matched this bank destination. Resolve in Revolut Business before re-sync. No payment will be sent.",
                    });
                  }}
                >
                  Review conflict
                </Button>
              </div>
              <p className="text-xs text-muted-foreground pt-1">
                Verify marks MANUAL_VERIFIED only. Sync attempts Revolut linkage (no payment). Never shows full sort code or account number.
              </p>
            </div>
          ) : (
            <p className="text-destructive">
              Payout destination is not configured (PAYOUT_DESTINATION_NOT_CONFIGURED).
            </p>
          )}
        </div>
      )}

      {!usesStripe && data?.audit && data.audit.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium flex items-center gap-2">
            <History className="h-4 w-4" />
            Change history
          </p>
          <div className="space-y-1 text-xs">
            {data.audit.map((row) => (
              <div key={row.id} className="flex justify-between gap-2 border-b border-border/50 py-1">
                <span>
                  {row.action} · {row.destination_type ?? row.provider}
                  {row.changed_by_role ? ` · ${row.changed_by_role}` : ""}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {format(new Date(row.created_at), "MMM d HH:mm")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
