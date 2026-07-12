/**
 * Thin public callback for Revolut Business OAuth.
 * Forwards authorization code to the edge function; never displays tokens.
 */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CheckCircle2, AlertCircle, Shield } from "lucide-react";

type ExchangeState = "idle" | "exchanging" | "success" | "error" | "need_login";

const PENDING_KEY = "revolut_business_oauth_pending";

function readPending(): { code: string; state: string } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as { code?: string; state?: string; saved_at?: number };
    if (!pending?.code || !pending.saved_at || Date.now() - pending.saved_at >= 120_000) return null;
    return { code: pending.code, state: pending.state ?? "" };
  } catch {
    return null;
  }
}

export default function RevolutBusinessOAuthCallback() {
  const [params] = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const [status, setStatus] = useState<ExchangeState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  const codeFromQuery = (params.get("code") ?? "").trim();
  const stateFromQuery = (params.get("state") ?? "").trim();
  const oauthError = (params.get("error") ?? "").trim();

  useEffect(() => {
    if (authLoading) return;
    if (oauthError) {
      setStatus("error");
      setMessage(oauthError);
      return;
    }

    const pending = readPending();
    const code = codeFromQuery || pending?.code || "";
    const state = stateFromQuery || pending?.state || "";

    if (codeFromQuery) {
      try {
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({ code: codeFromQuery, state: stateFromQuery, saved_at: Date.now() }),
        );
      } catch {
        // ignore
      }
    }

    if (!code) {
      setStatus("error");
      setMessage("Missing authorization code from Revolut.");
      return;
    }

    if (!user) {
      setStatus("need_login");
      setMessage("Sign in as an admin to complete token storage. The code is short-lived (~2 minutes).");
      return;
    }

    let cancelled = false;
    (async () => {
      setStatus("exchanging");
      setMessage("Exchanging authorization code on the server…");
      try {
        const { data, error } = await supabase.functions.invoke("admin-revolut-business-oauth", {
          body: { action: "exchange", code, state: state || null },
        });
        try {
          sessionStorage.removeItem(PENDING_KEY);
        } catch {
          // ignore
        }
        if (cancelled) return;
        if (error) {
          setStatus("error");
          setMessage(error.message || "Exchange failed");
          return;
        }
        if (!data?.ok) {
          setStatus("error");
          setMessage(String(data?.message ?? data?.error ?? data?.reason ?? "Exchange failed"));
          return;
        }
        setStatus("success");
        setExpiresAt(data.token_expires_at ?? null);
        setMessage(data.message ?? "Tokens stored securely. No payments were made.");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Exchange failed");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authLoading, user, codeFromQuery, stateFromQuery, oauthError]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <Card className="w-full max-w-lg border-slate-800 bg-slate-900 text-slate-50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Shield className="h-5 w-5" />
            Revolut Business authorization
          </CardTitle>
          <CardDescription className="text-slate-400">
            Server-side token exchange only. Access tokens are never shown in the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(status === "idle" || status === "exchanging" || authLoading) && (
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              {message ?? "Preparing…"}
            </div>
          )}
          {status === "success" && (
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Connected
              </div>
              <p className="text-slate-300">{message}</p>
              {expiresAt && (
                <p className="text-xs text-slate-500">Access token expires at {expiresAt}</p>
              )}
              <Button asChild className="mt-2">
                <Link to="/payment-providers">Open Payment Providers</Link>
              </Button>
            </div>
          )}
          {status === "need_login" && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-amber-400">
                <AlertCircle className="h-4 w-4" />
                Admin sign-in required
              </div>
              <p className="text-slate-300">{message}</p>
              <Button asChild>
                <Link to="/auth">Sign in to finish</Link>
              </Button>
              <p className="text-xs text-slate-500">
                Keep this tab, sign in, then reopen{" "}
                <Link className="underline" to="/auth/revolut/callback">
                  /auth/revolut/callback
                </Link>{" "}
                within 2 minutes.
              </p>
            </div>
          )}
          {status === "error" && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-2 text-red-400">
                <AlertCircle className="h-4 w-4" />
                Authorization failed
              </div>
              <p className="text-slate-300">{message}</p>
              <Button asChild variant="secondary">
                <Link to="/payment-providers">Back to Payment Providers</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
