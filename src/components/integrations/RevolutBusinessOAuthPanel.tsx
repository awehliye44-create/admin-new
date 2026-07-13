import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, Loader2, Link2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type RelayDiag = {
  configured?: boolean;
  base_url?: string | null;
  shared_secret_configured?: boolean;
  public_health_ok?: boolean | null;
  egress_ip?: string | null;
  egress_ip_matches_whitelist?: boolean | null;
  whitelist_ip?: string;
};

type GbpAccount = {
  id: string;
  name: string | null;
  balance_pence: number | null;
  currency: string | null;
  state?: string | null;
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
  gbp_accounts?: GbpAccount[];
  gbp_source_account_id?: string | null;
  gbp_balance_pence?: number | null;
  selected_source_account_id?: string | null;
  selected_source_account_ok?: boolean | null;
  selected_source_account_label?: string | null;
  selected_source_last_verified_at?: string | null;
  message?: string | null;
  authorization_url?: string;
  gaps?: Array<{ id: string; status: string; detail: string }>;
  ready_for_enable_access?: boolean;
};

function formatPence(pence: number | null | undefined): string {
  if (pence == null || !Number.isFinite(pence)) return "—";
  return `£${(pence / 100).toFixed(2)}`;
}

function maskAccountId(id: string | null | undefined): string {
  const value = String(id ?? "").trim();
  if (!value) return "—";
  if (value.length <= 12) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function formatVerifiedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
}

function isAccountActive(state: string | null | undefined): boolean {
  const s = String(state ?? "active").trim().toLowerCase();
  return !s || s === "active";
}

function canSelectAsSource(account: GbpAccount): { ok: true } | { ok: false; reason: string } {
  const currency = String(account.currency ?? "").toUpperCase();
  if (currency !== "GBP") {
    return { ok: false, reason: "Currency must be GBP" };
  }
  if (!isAccountActive(account.state)) {
    return { ok: false, reason: "Account is inactive" };
  }
  if (account.balance_pence == null || !Number.isFinite(account.balance_pence)) {
    return { ok: false, reason: "Provider balance cannot be verified" };
  }
  return { ok: true };
}

function statusBadgeVariant(status: string | undefined): "default" | "secondary" | "destructive" | "outline" {
  if (status === "TOKEN_PRESENT") return "default";
  if (status === "TOKEN_EXPIRED" || status === "ERROR") return "destructive";
  if (status === "AWAITING_CONSENT") return "secondary";
  return "outline";
}

export function RevolutBusinessOAuthPanel() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [diag, setDiag] = useState<Diag | null>(null);
  const [gaps, setGaps] = useState<Diag | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState<string | null>(null);

  async function invoke(
    action: string,
    extra: Record<string, unknown> = {},
    opts?: { trackBusy?: boolean },
  ) {
    const trackBusy = opts?.trackBusy !== false;
    if (trackBusy) setBusy(action);
    try {
      const { data, error } = await supabase.functions.invoke("admin-revolut-business-oauth", {
        body: { action, ...extra },
      });
      if (error) throw error;
      if (data?.ok === false && !["diagnostics", "gap_audit"].includes(action)) {
        throw new Error(String(data.message ?? data.error_code ?? data.error ?? "Request failed"));
      }
      return data as Diag & { ok?: boolean; authorization_url?: string; error_code?: string };
    } finally {
      if (trackBusy) setBusy((current) => (current === action ? null : current));
    }
  }

  const refreshDiagnostics = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      // Never lock Connect behind diagnostics — relay probes can be slow.
      const data = await invoke(
        "diagnostics",
        { include_accounts: true, probe_egress: false },
        { trackBusy: !opts?.silent },
      );
      setDiag(data);
      setLastVerifiedAt(new Date().toISOString());
      if (!opts?.silent) toast.success("Diagnostics refreshed");
      return data;
    } catch (err) {
      if (!opts?.silent) toast.error(err instanceof Error ? err.message : "Diagnostics failed");
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshDiagnostics({ silent: true });
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

  function navigateToRevolut(url: string) {
    // Revolut blocks iframes (X-Frame-Options). Always leave embedded previews.
    try {
      if (window.top && window.top !== window.self) {
        window.top.location.assign(url);
        return;
      }
    } catch {
      // cross-origin iframe — fall through
    }
    const opened = window.open(url, "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.assign(url);
    }
  }

  async function startOAuth(action: "connect" | "reconnect") {
    try {
      const data = await invoke(action);
      if (!data.authorization_url) {
        throw new Error("Authorization URL missing");
      }
      setAuthUrl(data.authorization_url);
      toast.success("Opening Revolut authorization…");
      navigateToRevolut(data.authorization_url);
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

  async function selectSource(account: GbpAccount) {
    const gate = canSelectAsSource(account);
    if (!gate.ok) {
      toast.error(gate.reason);
      return;
    }
    try {
      await invoke("select_source_account", { account_id: account.id });
      const name = account.name?.trim() || "GBP account";
      toast.success(`ACTIVE SOURCE set: ${name} (${formatPence(account.balance_pence)})`);
      await refreshDiagnostics({ silent: true });
      await queryClient.invalidateQueries({ queryKey: ["admin-payout-ledger"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Select failed");
    }
  }

  const showReconnect = useMemo(() => {
    const s = diag?.connection_status;
    return s === "TOKEN_EXPIRED" || s === "ERROR" || (s === "TOKEN_PRESENT" && !diag?.token_valid);
  }, [diag?.connection_status, diag?.token_valid]);

  const selectedSourceId = diag?.selected_source_account_id ?? null;
  const selectedAccount = useMemo(() => {
    if (!selectedSourceId) return null;
    return (diag?.gbp_accounts ?? []).find((a) => a.id === selectedSourceId) ?? null;
  }, [diag?.gbp_accounts, selectedSourceId]);

  const selectedBalancePence = selectedAccount?.balance_pence ?? diag?.gbp_balance_pence ?? null;
  const selectedHasZeroFunds =
    Boolean(selectedSourceId)
    && selectedBalancePence != null
    && Number.isFinite(selectedBalancePence)
    && selectedBalancePence <= 0;

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
            disabled={busy === "connect"}
            onClick={() => void startOAuth("connect")}
          >
            {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Link2 className="h-4 w-4 mr-1" />}
            Connect Revolut Business
          </Button>
          {showReconnect && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy === "reconnect"}
              onClick={() => void startOAuth("reconnect")}
            >
              {busy === "reconnect" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Reconnect Revolut Business
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy === "gap_audit"} onClick={() => void runGapAudit()}>
            {busy === "gap_audit" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Check gaps
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy === "diagnostics"}
            onClick={() => void refreshDiagnostics()}
          >
            {busy === "diagnostics" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Refresh diagnostics
          </Button>
        </div>

        {authUrl && (
          <div className="rounded-md border border-amber-500/40 bg-amber-50 p-3 space-y-2 text-sm">
            <p className="font-medium text-amber-900">
              If Revolut did not open, use this link (required outside Lovable preview)
            </p>
            <a
              className="text-primary underline break-all text-xs"
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {authUrl}
            </a>
            <div>
              <Button size="sm" variant="secondary" onClick={() => navigateToRevolut(authUrl)}>
                Open Revolut in new tab
              </Button>
            </div>
          </div>
        )}

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
          <div className="rounded-md border p-3 space-y-4 text-sm">
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
              <DiagRow label="Redirect URI" value={diag.redirect_uri ?? "https://adminonecab.net/auth/revolut/callback"} mono />
            </div>

            {diag.message && <p className="text-xs text-amber-700">{diag.message}</p>}

            <div
              className={cn(
                "rounded-lg border-2 p-4 space-y-2",
                selectedSourceId
                  ? "border-emerald-600 bg-emerald-50"
                  : "border-dashed border-muted-foreground/40 bg-muted/30",
              )}
            >
              <div className="text-xs font-semibold uppercase tracking-wide text-emerald-900">
                Selected payout source
              </div>
              {selectedSourceId ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-lg font-semibold">
                      {selectedAccount?.name?.trim() || diag.selected_source_account_label || "GBP account"}
                    </div>
                    <Badge className="bg-emerald-700 hover:bg-emerald-700">
                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                      ACTIVE SOURCE
                    </Badge>
                  </div>
                  <div className="grid gap-1 text-xs sm:grid-cols-2">
                    <div>
                      <span className="text-muted-foreground">Account ID: </span>
                      <span className="font-mono">{maskAccountId(selectedSourceId)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Available balance: </span>
                      <span className="font-semibold tabular-nums">{formatPence(selectedBalancePence)}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Currency: </span>
                      <span>{selectedAccount?.currency ?? "GBP"}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Last verified: </span>
                      <span>
                        {formatVerifiedAt(
                          diag.selected_source_last_verified_at
                            ?? lastVerifiedAt
                            ?? diag.token_expires_at,
                        )}
                      </span>
                    </div>
                  </div>
                  {selectedHasZeroFunds && (
                    <Alert variant="destructive" className="mt-2">
                      <AlertTitle>SELECTED SOURCE HAS NO AVAILABLE FUNDS</AlertTitle>
                      <AlertDescription>
                        This account is the active payout source but available balance is {formatPence(selectedBalancePence)}.
                        Select Main or another funded GBP account before funding company transfers.
                      </AlertDescription>
                    </Alert>
                  )}
                  {diag.selected_source_account_ok === false && (
                    <p className="text-xs text-amber-800">
                      Selected account ID is not present in the latest Revolut /accounts response.
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  SOURCE_ACCOUNT_NOT_CONFIGURED — choose a GBP account below via Use as source.
                </p>
              )}
            </div>

            {(diag.gbp_accounts ?? []).length > 0 && (
              <div className="space-y-2">
                <div className="font-medium text-sm">GBP accounts</div>
                <ul className="space-y-2">
                  {(diag.gbp_accounts ?? []).map((a) => {
                    const isActive = a.id === selectedSourceId;
                    const gate = canSelectAsSource(a);
                    return (
                      <li
                        key={a.id}
                        className={cn(
                          "flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3",
                          isActive
                            ? "border-2 border-emerald-600 bg-emerald-50 shadow-sm"
                            : "border-border bg-background",
                        )}
                      >
                        <div className="space-y-1 text-xs min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="font-medium text-sm">{a.name ?? "GBP account"}</div>
                            {isActive && (
                              <Badge className="bg-emerald-700 hover:bg-emerald-700">
                                ✓ Active payout source
                              </Badge>
                            )}
                          </div>
                          <div className="text-muted-foreground font-mono break-all">{a.id}</div>
                          <div className="tabular-nums">{formatPence(a.balance_pence)} · {a.currency ?? "GBP"}</div>
                          {!gate.ok && !isActive && (
                            <div className="text-amber-700">{gate.reason}</div>
                          )}
                        </div>
                        {isActive ? (
                          <Button size="sm" className="bg-emerald-700 hover:bg-emerald-700" disabled>
                            ACTIVE SOURCE
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy === "select_source_account" || !gate.ok}
                            title={!gate.ok ? gate.reason : "Use as source"}
                            onClick={() => void selectSource(a)}
                          >
                            {busy === "select_source_account" ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              "Use as source"
                            )}
                          </Button>
                        )}
                      </li>
                    );
                  })}
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
            <Button size="sm" disabled={busy === "exchange"} onClick={() => void exchangeManualCode()}>
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
