import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type Diag = {
  connection_status?: string;
  client_id_configured?: boolean;
  private_key_configured?: boolean;
  access_token_configured?: boolean;
  refresh_token_configured?: boolean;
  token_expires_at?: string | null;
  token_expires_in_seconds?: number | null;
  redirect_uri?: string;
  oauth_scope?: string;
  live_payout_execution_enabled?: boolean;
  egress_public_ip?: string | null;
  whitelist_recommendation?: string;
  gbp_accounts?: Array<{
    id: string;
    name: string | null;
    balance_pence: number | null;
    currency: string | null;
  }>;
  selected_source_account_id?: string | null;
  message?: string | null;
  authorization_url?: string;
};

function formatPence(pence: number | null | undefined): string {
  if (pence == null || !Number.isFinite(pence)) return "—";
  return `£${(pence / 100).toFixed(2)}`;
}

export function RevolutBusinessOAuthPanel() {
  const [busy, setBusy] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);

  async function invoke(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    try {
      const { data, error } = await supabase.functions.invoke("admin-revolut-business-oauth", {
        body: { action, ...extra },
      });
      if (error) throw error;
      if (data?.ok === false && action !== "diagnostics") {
        throw new Error(String(data.message ?? data.error ?? "Request failed"));
      }
      return data as Diag & { ok?: boolean; authorization_url?: string };
    } finally {
      setBusy(null);
    }
  }

  async function refreshDiagnostics() {
    try {
      const data = await invoke("diagnostics", { include_accounts: true, probe_egress: true });
      setDiag(data);
      toast.success("Diagnostics refreshed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Diagnostics failed");
    }
  }

  async function prepareAuth() {
    try {
      const data = await invoke("prepare");
      if (data.authorization_url) {
        setAuthUrl(data.authorization_url);
        toast.success("Authorization URL ready — open it after Enable access");
      }
      await refreshDiagnostics();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Prepare failed");
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Revolut Business API (read-only)</CardTitle>
        <CardDescription>
          OAuth consent and company-balance diagnostics. Live payouts stay disabled.
          Tokens never appear in this UI.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void refreshDiagnostics()}>
            {busy === "diagnostics" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Refresh diagnostics
          </Button>
          <Button size="sm" disabled={!!busy} onClick={() => void prepareAuth()}>
            {busy === "prepare" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Prepare authorization URL
          </Button>
        </div>

        {authUrl && (
          <div className="rounded-md border p-3 text-xs break-all space-y-2">
            <div className="font-medium text-sm">Authorization URL</div>
            <a className="text-primary underline" href={authUrl} target="_blank" rel="noreferrer">
              {authUrl}
            </a>
            <p className="text-muted-foreground">
              Before Enable access in Revolut, set OAuth redirect URI to:
              {" "}
              <code className="break-all">{diag?.redirect_uri ?? "https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/admin-revolut-business-oauth-callback"}</code>
              {" "}(JWT iss must match that host). Do not use admin.onecab.net — that host is Laravel, not this SPA.
            </p>
          </div>
        )}

        {diag && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2 items-center">
              <Badge variant="outline">{diag.connection_status ?? "—"}</Badge>
              <Badge variant={diag.live_payout_execution_enabled ? "destructive" : "secondary"}>
                live payouts: {diag.live_payout_execution_enabled ? "ON" : "OFF"}
              </Badge>
              <Badge variant="outline">scope: {diag.oauth_scope ?? "READ"}</Badge>
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground">
              <div>Client ID configured: {String(!!diag.client_id_configured)}</div>
              <div>Private key configured: {String(!!diag.private_key_configured)}</div>
              <div>Access token configured: {String(!!diag.access_token_configured)}</div>
              <div>Refresh token configured: {String(!!diag.refresh_token_configured)}</div>
              <div>Token expires at: {diag.token_expires_at ?? "—"}</div>
              <div>Egress IP (this call): {diag.egress_public_ip ?? "—"}</div>
              <div>Whitelist: {diag.whitelist_recommendation ?? "DO_NOT_WHITELIST_YET"}</div>
              <div>Selected source: {diag.selected_source_account_id ?? "—"}</div>
              {diag.message && <div className="text-amber-700">Note: {diag.message}</div>}
            </div>

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
      </CardContent>
    </Card>
  );
}
