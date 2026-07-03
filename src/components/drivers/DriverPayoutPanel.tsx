import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { CreditCard, History, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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

export function DriverPayoutPanel({
  driverId,
  serviceAreaId,
  regionId,
  stripeAccountId,
  payoutsEnabled,
  onboardingComplete,
  chargesEnabled,
}: DriverPayoutPanelProps) {
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
            .select("name, driver_payout_gateway")
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
            "id, provider, destination_type, destination_label, destination_last4, account_holder_name, is_active, updated_at",
          )
          .eq("driver_id", driverId)
          .eq("is_active", true)
          .is("archived_at", null)
          .maybeSingle(),
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
        destination: destinationRes.data,
        audit: auditRes.data ?? [],
      };
    },
    enabled: Boolean(driverId),
  });

  const payoutGateway = data?.serviceArea?.driver_payout_gateway ?? "stripe";
  const usesStripe = payoutGateway === "stripe";
  const region = data?.region;
  const destination = data?.destination;

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

      {usesStripe ? (
        <div className="space-y-2 text-sm">
          <p className="font-medium">Stripe Connect</p>
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
            <p className="text-muted-foreground">Driver has not connected Stripe Connect.</p>
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
                {destination.destination_label ?? `****${destination.destination_last4 ?? ""}`}
              </p>
              {destination.updated_at ? (
                <p className="text-xs text-muted-foreground">
                  Last changed {format(new Date(destination.updated_at), "MMM d, yyyy HH:mm")}
                </p>
              ) : null}
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
