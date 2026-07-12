import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Link2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type RelayDiag = {
  configured?: boolean;
  base_url?: string | null;
  shared_secret_configured?: boolean;
  public_health_ok?: boolean | null;
  egress_ip?: string | null;
  egress_ip_matches_whitelist?: boolean | null;
  whitelist_ip?: string;
};

type Diag = {
  connection_status?: string;
  client_id_configured?: boolean;
  client_id_source?: string;
  client_id_matches_certificate?: boolean;
  client_id_hint?: string | null;
  certificate_configured?: boolean;
  private_key_configured?: boolean;
  oauth_connected?: boolean;
  access_token_configured?: boolean;
  refresh_token_configured?: boolean;
  token_valid?: boolean;
  token_expires_at?: string | null;
  token_expires_in_seconds?: number | null;
  redirect_uri?: string;
  jwt_iss?: string;
  oauth_scope?: string;
  live_payout_execution_enabled?: boolean;
  relay?: RelayDiag;
  egress_public_ip?: string | null;
  egress_ip_fixed_proven?: boolean;
  whitelist_recommendation?: string;
  gbp_accounts?: Array<{
    id: string;
    name: string | null;
    balance_pence: number | null;
    currency: string | null;
  }>;
  gbp_source_account_id?: string | null;
  gbp_balance_pence?: number | null;
  selected_source_account_id?: string | null;
  message?: string | null;
  authorization_url?: string;
  gaps?: Array<{ id: string; status: string; detail: string }>;
  ready_for_enable_access?: boolean;
};

function formatPence(pence: number | null | undefined): string {
  if (pence == null || !Number.isFinite(pence)) return "—";
  return `£${(pence / 100).toFixed(2)}`;
}

function statusBadgeVariant(status: string | undefined): "default" | "secondary" | "destructive" | "outline" {
  if (status === "TOKEN_PRESENT") return "default";
  if (status === "TOKEN_EXPIRED" || status === "ERROR") return "destructive";
  if (status === "AWAITING_CONSENT") return "secondary";
  return "outline";
}

export function RevolutBusinessOAuthPanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [gaps, setGaps] = useState<Diag | null>(null);
  const [manualCode, setManualCode] = useState("");

  async function invoke(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      const { data, error } = await supabase.functions.invoke("admin-revolut-business-oauth", {
        body: { action, ...extra },
      });
      if (error) throw error;
      if (data?.ok === false && !["diagnostics", "gap_audit"].includes(action)) {
        throw new Error(String(data.message ?? data.error ?? "Request failed"));
      }
      return data as Diag & { ok?: boolean; authorization_url?: string };
    } finally {
      setBusy(null);
    }
  }

  const refreshDiagnostics = useCallback(async () => {
    try {
      const data = await invoke("diagnostics", { include_accounts: true, probe_egress: true });
      setDiag(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Diagnostics failed");
    }
  }, []);

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  async function runGapAudit() {
    try {
      const data = await invoke("gap_audit");
      setGaps(data);
      toast.success(data.ready_for_enable_access ? "Ready to connect" : "Gaps remain — see list");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gap audit failed");
    }
  }

  async function startOAuth(action: "connect" | "reconnect") {
    try {
      const data = await invoke(action);
      if (!data.authorization_url) {
        throw new Error("Authorization URL missing");
      }
      toast.success("Redirecting to Revolut…");
      window.location.assign(data.authorization_url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start authorization");
      await runGapAudit();
    }
  }

  async function exchangeManualCode() {
    const code = manualCode.trim();
    if (!code) {
      toast.error("Paste the Revolut authorization code first");
      return;
    }
    try {
      await invoke("exchange", { code });
      setManualCode("");
      toast.success("Tokens stored (no payouts)");
      await refreshDiagnostics();
      await runGapAudit();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Exchange failed");
    }
  }

  async function selectSource(accountId: string) {
    try {
      await invoke("select_source_account", { account_id: accountId });
      toast.success("Source account selected");
      await refreshDiagnostics();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Select failed");
    }
  }

  const showReconnect = useMemo(() => {
    const s = diag?.connection_status;
    return s === "TOKEN_EXPIRED" || s === "ERROR" || (s === "TOKEN_PRESENT" && !diag?.token_valid);
  }, [diag?.connection_status, diag?.token_valid]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Revolut Business API (read-only)</CardTitle>
        <CardDescription>
          OAuth consent and company-balance diagnostics via fixed-IP relay ({diag?.relay?.whitelist_ip ?? "63.186.194.116"}).
          Live payouts stay disabled. Tokens never appear in this UI.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!!busy}
            onClick={() => void startOAuth("connect")}
          >
            {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Link2 className="h-4 w-4 mr-1" />}
            Connect Revolut Business
          </Button>
          {showReconnect && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!!busy}
              onClick={() => void startOAuth("reconnect")}
            >
              {busy === "reconnect" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Reconnect Revolut Business
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void runGapAudit()}>
            {busy === "gap_audit" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Check gaps
          </Button>
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void refreshDiagnostics()}>
            {busy === "diagnostics" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Refresh diagnostics
          </Button>
        </div>

        {gaps && (
          <div className="rounded-md border p-3 space-y-2 text-xs">
            <div className="flex flex-wrap gap-2 items-center">
              <Badge variant={gaps.ready_for_enable_access ? "default" : "destructive"}>
                {gaps.ready_for_enable_access ? "Ready to connect" : "Gaps open"}
              </Badge>
              <span className="text-muted-foreground">iss={gaps.jwt_iss}</span>
            </div>
            <ul className="space-y-1">
              {(gaps.gaps ?? []).map((g) => (
                <li key={g.id} className="flex gap-2">
                  <Badge variant="outline">{g.status}</Badge>
                  <span><span className="font-mono">{g.id}</span> — {g.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {diag && (
          <div className="rounded-md border p-3 space-y-3 text-sm">
            <div className="flex flex-wrap gap-2 items-center">
              <Badge variant={statusBadgeVariant(diag.connection_status)}>{diag.connection_status ?? "—"}</Badge>
              <Badge variant={diag.live_payout_execution_enabled ? "destructive" : "secondary"}>
                live payouts: {diag.live_payout_execution_enabled ? "ON" : "OFF"}
              </Badge>
              <Badge variant="outline">scope: {diag.oauth_scope ?? "READ"}</Badge>
              {diag.oauth_connected && (
                <Badge variant="default">OAuth connected</Badge>
              )}
            </div>

            <div className="grid gap-2 sm:grid-cols-2 text-xs">
              <DiagRow label="Certificate configured" value={String(!!diag.certificate_configured)} />
              <DiagRow label="Client ID source" value={diag.client_id_source ?? "REVOLUT_BUSINESS_CLIENT_ID"} />
              <DiagRow
                label="Client ID matches certificate"
                value={diag.client_id_matches_certificate ? "yes" : "no"}
                hint={diag.client_id_hint ?? undefined}
              />
              <DiagRow label="Relay reachable" value={
                diag.relay?.public_health_ok == null ? "—" : diag.relay.public_health_ok ? "yes" : "no"
              } />
              <DiagRow label="Relay egress IP" value={diag.relay?.egress_ip ?? "—"} />
              <DiagRow label="Whitelist match" value={
                diag.relay?.egress_ip_matches_whitelist == null ? "—" : diag.relay.egress_ip_matches_whitelist ? "yes" : "no"
              } />
              <DiagRow label="OAuth connected" value={String(!!diag.oauth_connected)} />
              <DiagRow label="Token valid" value={String(!!diag.token_valid)} />
              <DiagRow label="Token expires at" value={diag.token_expires_at ?? "—"} />
              <DiagRow label="GBP source account" value={diag.gbp_source_account_id ?? "—"} mono />
              <DiagRow label="GBP balance" value={formatPence(diag.gbp_balance_pence)} />
              <DiagRow label="Redirect URI" value={diag.redirect_uri ?? "https://adminonecab.net/auth/revolut/callback"} mono />
            </div>

            {diag.message && <p className="text-xs text-amber-700">{diag.message}</p>}

            {(diag.gbp_accounts ?? []).length > 0 && (
              <div className="space-y-2">
                <div className="font-medium text-sm">GBP accounts</div>
                <ul className="space-y-2">
                  {(diag.gbp_accounts ?? []).map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2">
                      <div className="text-xs">
                        <div className="font-medium">{a.name ?? "GBP account"}</div>
                        <div className="text-muted-foreground font-mono">{a.id}</div>
                        <div>{formatPence(a.balance_pence)}</div>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => void selectSource(a.id)}>
                        Use as source
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="rounded-md border p-3 space-y-2">
          <div className="font-medium text-sm">Manual code exchange (fallback)</div>
          <p className="text-xs text-muted-foreground">
            Normal path: tap Connect → Revolut redirects to{" "}
            <code>https://adminonecab.net/auth/revolut/callback</code>.
            If that fails, paste the <code>code</code> from the address bar within ~2 minutes.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              placeholder="oa_prod_…"
              className="max-w-md font-mono text-xs"
            />
            <Button size="sm" disabled={!!busy} onClick={() => void exchangeManualCode()}>
              {busy === "exchange" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Exchange code
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DiagRow({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono break-all" : ""}>
        {value}
        {hint ? <span className="text-muted-foreground ml-1">({hint})</span> : null}
      </div>
    </div>
  );
}
