#!/usr/bin/env bash
# After `supabase start`, GoTrue may leave phone disabled even with test_otp.
# Recreate the auth container with GOTRUE_EXTERNAL_PHONE_ENABLED=true.
# Uses SMS test_otp from config.toml — no paid Twilio SMS.
set -euo pipefail
NAME="${1:-supabase_auth_thazislrdkjpvvghtvzo}"
if ! docker ps -q -f "name=^/${NAME}$" | grep -q .; then
  # fuzzy match
  NAME=$(docker ps --format '{{.Names}}' | grep -E '^supabase_auth_' | head -1 || true)
fi
if [[ -z "${NAME}" ]]; then
  echo "No supabase_auth container running. Start local stack first: supabase start" >&2
  exit 1
fi
CID=$(docker ps -qf "name=^/${NAME}$")
IMG=$(docker inspect -f '{{.Config.Image}}' "$CID")
NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$CID")
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$CID" \
  | grep -v '^GOTRUE_EXTERNAL_PHONE_ENABLED=' \
  | grep -v '^GOTRUE_SMS_AUTOCONFIRM=' > /tmp/onecab-auth-env.txt
echo 'GOTRUE_EXTERNAL_PHONE_ENABLED=true' >> /tmp/onecab-auth-env.txt
# Autoconfirm must be false or GoTrue never issues a verifiable phone_change OTP.
echo 'GOTRUE_SMS_AUTOCONFIRM=false' >> /tmp/onecab-auth-env.txt
docker stop "$NAME" >/dev/null
docker rm "$NAME" >/dev/null
docker run -d --name "$NAME" --env-file /tmp/onecab-auth-env.txt --network "$NET" \
  --label com.supabase.cli.project=thazislrdkjpvvghtvzo \
  "$IMG" >/dev/null
sleep 2
docker exec "$NAME" printenv GOTRUE_EXTERNAL_PHONE_ENABLED
docker exec "$NAME" printenv GOTRUE_SMS_AUTOCONFIRM
docker exec "$NAME" printenv GOTRUE_SMS_TEST_OTP | head -c 80; echo
echo "Phone Auth enabled for local QA (test OTP only; SMS autoconfirm off)."
