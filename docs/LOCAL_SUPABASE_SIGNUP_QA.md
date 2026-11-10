# Local Docker Supabase — Driver/Customer signup QA

No paid cloud staging project. Production `thazislrdkjpvvghtvzo` stays untouched.

## Start

```bash
cd /Users/admin/admin-new
supabase start
bash scripts/staging/enable-local-phone-auth.sh   # phone + test OTP (no paid SMS)
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -f scripts/staging/seed-signup-catalogue.sql
bash scripts/staging/serve-signup-edges.sh
```

Studio: http://127.0.0.1:54323  
Mailpit (email capture): http://127.0.0.1:54324  
API: http://127.0.0.1:54321 (device: `http://<LAN-IP>:54321`)

## Test OTP (no paid SMS)

Configured in `supabase/config.toml` `[auth.sms.test_otp]` (local only — never `config push` to production).

Must pass `libphonenumber` (Ofcom `07700 900xxx` numbers are **invalid** and rejected by Edge validation):

| E.164 | OTP | Use | libphonenumber country |
|-------|-----|-----|------------------------|
| `+447911111111` | `111111` | Driver | **GG** (Guernsey) — seed must enable `GG` |
| `+447922222222` | `222222` | Customer | GB |
| `+447933333333` | `333333` | Spare | GB |
| `+447944444444` | `444444` | Spare | GB |

Also seed `otp_allowed_countries` with `GB` **and** `GG` (via `seed-signup-catalogue.sql`). After every `supabase start`, run `enable-local-phone-auth.sh` (forces phone on + `SMS_AUTOCONFIRM=false`).

## App `.env.qa`

Driver + Customer gitignored `.env.qa` point at LAN Docker URL with:

- `EXPO_PUBLIC_SUPABASE_PROJECT_REF=local-docker` (never production ref)
- `EXPO_PUBLIC_QA_BUILD=true`
- Refuse production URL / ref / readonly flags (see app `env.ts`)

## Device testing checklist

1. Firebase: `android/app/src/qa/google-services.json` still required to **assemble** `.qa` APKs (separate from Auth). Until registered, use Metro against a store debug build only if explicitly approved — prefer completing Firebase QA apps first.
2. Physical device and Mac on same Wi‑Fi; URL host = Mac LAN IP.
3. Customer: Register → phone `+447700900002` → OTP `222222` → finalize.
4. Driver: Create Account → region QA England → email (Mailpit) → phone `+447700900001` / OTP `111111` → finalize.
5. Recovery: password recovery flows against local Auth + Mailpit (no production).

## Restrictions

- No production deploy / OTA / Edge deploy to `thazislrdkjpvvghtvzo`
- No paid SMS without approval
- No new paid Supabase project without approval
