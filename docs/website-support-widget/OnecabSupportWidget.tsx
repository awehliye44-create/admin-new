/**
 * ONECAB website support widget (drop-in for the onecab.net Lovable project).
 *
 * Availability-gated: renders NOTHING unless `admin-support-status` reports
 * available === true. Polls every 30s. Fails closed on any error.
 *
 * Backend (already deployed on the ONECAB backend Supabase project):
 *   POST /functions/v1/admin-support-status   -> { available: boolean }
 *   POST /functions/v1/website-support-chat   -> { action: 'start'|'send'|'poll', ... }
 *
 * Messages land in the EXISTING Admin -> Live Chat (support_conversations /
 * support_messages, channel = 'website'). No new support system, no tickets.
 *
 * Copy this file into src/components/ of the website project and render
 * <OnecabSupportWidget /> once in the root layout (e.g. App.tsx).
 */
import { useCallback, useEffect, useRef, useState } from "react";

const BACKEND_URL = "https://thazislrdkjpvvghtvzo.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRoYXppc2xyZGtqcHZ2Z2h0dnpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc4NzA1MjIsImV4cCI6MjA4MzQ0NjUyMn0.pXaycIz1t7JXuItyqvjNNrFsZpsaXbB5bV1OWSQLbWM";

const AVAILABILITY_POLL_MS = 30_000;
const MESSAGE_POLL_MS = 5_000;
const SESSION_KEY = "onecab_support_session";

type ChatMessage = { id: string; from: string; content: string; created_at: string };

async function callFn<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BACKEND_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${fn}_failed_${res.status}`);
  return (await res.json()) as T;
}

export function OnecabSupportWidget() {
  const [available, setAvailable] = useState(false); // fail closed
  const [open, setOpen] = useState(false);
  const [sessionToken, setSessionToken] = useState<string | null>(
    () => (typeof window !== "undefined" ? window.localStorage.getItem(SESSION_KEY) : null),
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeen = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /* -------- availability gate (30s poll, fail closed) -------- */
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const data = await callFn<{ available?: boolean }>("admin-support-status", {});
        if (!cancelled) setAvailable(data?.available === true);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    };
    void check();
    const id = window.setInterval(check, AVAILABILITY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!available) setOpen(false);
  }, [available]);

  /* -------- message polling while a session exists and panel is open -------- */
  const poll = useCallback(async () => {
    if (!sessionToken) return;
    try {
      const data = await callFn<{ status: string; messages: ChatMessage[] }>(
        "website-support-chat",
        { action: "poll", session_token: sessionToken, since: lastSeen.current ?? undefined },
      );
      if (data.messages?.length) {
        lastSeen.current = data.messages[data.messages.length - 1].created_at;
        setMessages((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...data.messages.filter((m) => !seen.has(m.id))];
        });
      }
      if (data.status === "closed" || data.status === "resolved") {
        window.localStorage.removeItem(SESSION_KEY);
        setSessionToken(null);
      }
    } catch {
      /* transient — keep the panel usable */
    }
  }, [sessionToken]);

  useEffect(() => {
    if (!open || !sessionToken) return;
    void poll();
    const id = window.setInterval(poll, MESSAGE_POLL_MS);
    return () => window.clearInterval(id);
  }, [open, sessionToken, poll]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      if (!sessionToken) {
        const data = await callFn<{ session_token: string }>("website-support-chat", {
          action: "start",
          name: name.trim() || undefined,
          email: email.trim() || undefined,
          message: text,
        });
        window.localStorage.setItem(SESSION_KEY, data.session_token);
        setSessionToken(data.session_token);
      } else {
        await callFn("website-support-chat", {
          action: "send",
          session_token: sessionToken,
          message: text,
        });
      }
      setMessages((prev) => [
        ...prev,
        { id: `local-${Date.now()}`, from: "customer", content: text, created_at: new Date().toISOString() },
      ]);
      setDraft("");
    } catch {
      setError("Message could not be sent. Please try again.");
    } finally {
      setSending(false);
    }
  };

  if (!available) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-3">
      {open && (
        <div className="w-[320px] max-w-[calc(100vw-2.5rem)] overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">ONECAB Support</p>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                Online now
              </p>
            </div>
            <button
              type="button"
              aria-label="Close support chat"
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted"
            >
              ×
            </button>
          </div>

          <div ref={scrollRef} className="max-h-64 space-y-2 overflow-y-auto px-4 py-3">
            {messages.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Hi — how can ONECAB support help you today?
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.from === "admin"
                    ? "mr-auto w-fit max-w-[85%] rounded-xl bg-muted px-3 py-2 text-sm text-foreground"
                    : "ml-auto w-fit max-w-[85%] rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground"
                }
              >
                {m.content}
              </div>
            ))}
          </div>

          <div className="space-y-2 border-t border-border px-4 py-3">
            {!sessionToken && (
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name (optional)"
                  className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                />
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email (optional)"
                  className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                />
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={2}
                placeholder="Type your message…"
                className="flex-1 resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                onClick={() => void submit()}
                disabled={sending || !draft.trim()}
                className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                Send
              </button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg"
      >
        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
        Live Support
      </button>
    </div>
  );
}

export default OnecabSupportWidget;
