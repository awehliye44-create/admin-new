#!/usr/bin/env bash
# Serve signup-only Edge Functions against local Docker Supabase (no cloud deploy).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${1:-$ROOT/.staging/edge.local.env}"
mkdir -p "$ROOT/.staging"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'EOF'
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
# Driver email verify — leave empty to skip Resend; use Mailpit / manual token for local.
RESEND_API_KEY=
RESEND_FROM_EMAIL=noreply@onecab.net
EOF
  chmod 600 "$ENV_FILE"
  echo "Wrote $ENV_FILE (fill RESEND_API_KEY only if testing Driver email send)."
fi

FUNCS=(
  create-onboarding-auth-user
  driver-signup-location-options
  send-account-email-verification
  account-email-verify-link
  verify-account-email
  send-driver-phone-otp
  send-customer-phone-otp
  verify-customer-phone-otp
  finalize-customer-onboarding
)

echo "Serving signup Edge set on local functions gateway…"
echo "Functions: ${FUNCS[*]}"
exec supabase functions serve --env-file "$ENV_FILE" --no-verify-jwt "${FUNCS[@]}"
