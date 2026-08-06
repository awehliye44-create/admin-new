#!/usr/bin/env bash
# Phase B environment gate for Revolut same-order incremental authorisation.
#
# thazislrdkjpvvghtvzo is the approved pre-production live-testing backend
# (internal Customer/Driver/Admin testing — not external production launch).
# Absence of a second Supabase project is not a blocker.
#
# Decisive remaining gate: prove Revolut sandbox vs live.
# - sandbox credentials + sandbox base URL → payment matrix allowed after migrate/deploy approval
# - live credentials + live base URL → migrate/deploy may be approved separately;
#   payment transactions require additional controlled-live approval
#
# Usage:
#   TARGET_PROJECT_REF=thazislrdkjpvvghtvzo \
#   PREPROD_LIVE_TESTING_APPROVED=true \
#   REVOLUT_ENVIRONMENT=sandbox|live \
#   REVOLUT_MERCHANT_SECRET_KEY_CLASS=sk_sandbox_|sk_|sk_live_|unknown \
#   REVOLUT_MERCHANT_BASE_URL=https://sandbox-merchant.revolut.com/api|https://merchant.revolut.com/api \
#   ALLOW_PAYMENT_TRANSACTIONS=false|true \
#   bash scripts/phase-b-revolut-increment-gate.sh
set -euo pipefail

APPROVED_PREPROD_REF="thazislrdkjpvvghtvzo"
TARGET_REF="${TARGET_PROJECT_REF:-}"

if [[ -z "$TARGET_REF" ]]; then
  echo "ABORT: TARGET_PROJECT_REF is required."
  exit 2
fi

if [[ "$TARGET_REF" != "$APPROVED_PREPROD_REF" ]]; then
  echo "ABORT: TARGET_PROJECT_REF must be exactly ${APPROVED_PREPROD_REF} (got: ${TARGET_REF})."
  exit 2
fi

if [[ "${PREPROD_LIVE_TESTING_APPROVED:-}" != "true" ]]; then
  echo "ABORT: PREPROD_LIVE_TESTING_APPROVED must be exactly 'true' (explicit Phase B approval for this pre-prod live-testing env)."
  exit 2
fi

REVOLUT_ENV="${REVOLUT_ENVIRONMENT:-}"
KEY_CLASS="${REVOLUT_MERCHANT_SECRET_KEY_CLASS:-}"
BASE_URL="${REVOLUT_MERCHANT_BASE_URL:-}"
ALLOW_PAY="${ALLOW_PAYMENT_TRANSACTIONS:-false}"

if [[ "$REVOLUT_ENV" != "sandbox" && "$REVOLUT_ENV" != "live" ]]; then
  echo "ABORT: REVOLUT_ENVIRONMENT must be 'sandbox' or 'live' (got: '${REVOLUT_ENV}'). Never label sandbox without proof."
  exit 2
fi

if [[ -z "$KEY_CLASS" || -z "$BASE_URL" ]]; then
  echo "ABORT: REVOLUT_MERCHANT_SECRET_KEY_CLASS and REVOLUT_MERCHANT_BASE_URL are required proof fields."
  exit 2
fi

if [[ "$REVOLUT_ENV" == "sandbox" ]]; then
  if [[ "$KEY_CLASS" != sk_sandbox_* && "$KEY_CLASS" != "sk_sandbox_" ]]; then
    echo "ABORT: sandbox claim requires secret key class sk_sandbox_ (got: ${KEY_CLASS})."
    exit 2
  fi
  if [[ "$BASE_URL" != "https://sandbox-merchant.revolut.com/api" ]]; then
    echo "ABORT: sandbox claim requires base URL https://sandbox-merchant.revolut.com/api (got: ${BASE_URL})."
    exit 2
  fi
fi

if [[ "$REVOLUT_ENV" == "live" ]]; then
  if [[ "$KEY_CLASS" == sk_sandbox_* || "$KEY_CLASS" == "sk_sandbox_" ]]; then
    echo "ABORT: live claim contradicts sk_sandbox_ key class."
    exit 2
  fi
  if [[ "$BASE_URL" != "https://merchant.revolut.com/api" ]]; then
    echo "ABORT: live claim requires base URL https://merchant.revolut.com/api (got: ${BASE_URL})."
    exit 2
  fi
  if [[ "$ALLOW_PAY" == "true" ]]; then
    if [[ "${CONTROLLED_LIVE_PAYMENT_APPROVED:-}" != "true" ]]; then
      echo "ABORT: Revolut is LIVE. Payment transactions require CONTROLLED_LIVE_PAYMENT_APPROVED=true (separate explicit approval)."
      exit 2
    fi
  else
    echo "NOTE: Revolut is LIVE. Gate allows non-payment Phase B steps only when ALLOW_PAYMENT_TRANSACTIONS=false."
    echo "NOTE: Do not execute payment transactions without separate controlled-live approval."
  fi
fi

# Optional direct key inspection (never echo the key)
if [[ -n "${REVOLUT_MERCHANT_SECRET_KEY:-}" ]]; then
  if [[ "${REVOLUT_MERCHANT_SECRET_KEY}" == sk_sandbox* ]]; then
    DETECTED="sandbox"
  else
    DETECTED="live"
  fi
  if [[ "$DETECTED" != "$REVOLUT_ENV" ]]; then
    echo "ABORT: REVOLUT_MERCHANT_SECRET_KEY prefix resolves to ${DETECTED} but REVOLUT_ENVIRONMENT=${REVOLUT_ENV}."
    exit 2
  fi
fi

echo "GATE PASS (environment)"
echo "classification: approved pre-production live-testing backend"
echo "Supabase project ref: $TARGET_REF"
echo "Revolut environment: $REVOLUT_ENV"
echo "Revolut secret key class: $KEY_CLASS"
echo "Revolut merchant base URL: $BASE_URL"
echo "payment_transactions_allowed: $ALLOW_PAY"
