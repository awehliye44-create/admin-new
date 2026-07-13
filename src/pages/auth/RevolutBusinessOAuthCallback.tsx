/**
 * Public Revolut Business OAuth callback.
 * Accepts code/state/error query params, then forwards to the Edge exchange.
 * Never displays access tokens, refresh tokens, JWTs, or private key material.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, AlertCircle, Shield } from "lucide-react";

const EDGE_CALLBACK =
  "https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/admin-revolut-business-oauth-callback";

const SAFE_ERROR_MAX = 240;

function sanitizePublicError(raw: string | null | undefined): string {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, SAFE_ERROR_MAX);
  if (!cleaned) return "authorization_failed";
  if (/access_token|refresh_token|Bearer\s|BEGIN (RSA )?PRIVATE KEY|assertion/i.test(cleaned)) {
    return "authorization_failed";
  }
  return cleaned;
}

export default function RevolutBusinessOAuthCallback() {
  const [params] = useSearchParams();
  const [status, setStatus] = useState<"forwarding" | "error">("forwarding");
  const [message, setMessage] = useState("Forwarding authorization code to the server…");

  const code = (params.get("code") ?? "").trim();
  const state = (params.get("state") ?? "").trim();
  const oauthError = (params.get("error") ?? "").trim();
  const oauthErrorDescription = (params.get("error_description") ?? "").trim();

  const errorText = useMemo(() => {
    if (!oauthError) return null;
    const base = sanitizePublicError(oauthError);
    const detail = sanitizePublicError(oauthErrorDescription);
    if (detail && detail !== "authorization_failed" && detail !== base) {
      return `${base} — ${detail}`;
    }
    return base;
  }, [oauthError, oauthErrorDescription]);

  useEffect(() => {
    if (errorText) {
      setStatus("error");
      setMessage(errorText);
      return;
    }

    if (!code) {
      setStatus("error");
      setMessage("Missing authorization code from Revolut. Start again from Payment Providers.");
      return;
    }

    const q = new URLSearchParams();
    q.set("code", code);
    if (state) q.set("state", state);
    q.set("format", "json");
    const target = `${EDGE_CALLBACK}?${q.toString()}`;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 14_000);

    // JSON bridge avoids cross-origin 302 Location opacity and hanging location.replace.
    void fetch(target, {
      method: "GET",
      signal: controller.signal,
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json" },
    })
      .then(async (res) => {
        window.clearTimeout(timer);
        const body = (await res.json().catch(() => ({}))) as {
          redirect_to?: string;
          reason?: string;
        };
        const redirectTo = body.redirect_to;
        if (typeof redirectTo === "string" && /^https:\/\/adminonecab\.net\//.test(redirectTo)) {
          window.location.replace(redirectTo);
          return;
        }
        setStatus("error");
        setMessage(
          body.reason ||
            "Server did not complete authorization. The fixed-IP relay may be down (port 8787).",
        );
      })
      .catch((err: unknown) => {
        window.clearTimeout(timer);
        const aborted =
          err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
        setStatus("error");
        setMessage(
          aborted
            ? "Timed out waiting for the server. The fixed-IP relay at 63.186.194.116:8787 is unreachable."
            : "Could not reach the authorization server. Bring the relay up, then try Connect again.",
        );
      });

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [code, state, errorText]);

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
          {status === "forwarding" && (
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              {message}
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
