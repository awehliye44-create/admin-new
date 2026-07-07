# ONECAB Payment Provider SSOT

**Status:** Canonical  
**Code:** `shared/onecabPaymentProviderSSOT.ts`  
**Mirrors:** `supabase/functions/_shared/onecabPaymentProviderSSOT.ts`, `src/lib/onecabPaymentProviderSSOT.ts`

## Principle

The **service area** determines the payment provider. The **customer experience must remain identical** across all service areas.

Customers and drivers **must never know or choose** which payment provider is being used. That is a **backend responsibility**.

---

## Customer payment methods (global)

These are standard **ONECAB features** and must be available regardless of the selected payment provider, **when that provider's adapter supports them**:

| Method | ONECAB product |
|--------|----------------|
| Card | ✓ |
| Saved cards | ✓ (platform feature) |
| Apple Pay | ✓ |
| Google Pay | ✓ |
| Mobile wallets | ✓ |
| Pay by bank | ✓ (where adapter supports) |
| ONECAB Wallet | ✓ |

### Forbidden customer/driver copy

The UI must **never** display:

- "Provider unsupported"
- "Stripe only" / "Revolut only"
- "Via Stripe" / "Via Revolut"
- "Payment provider" (in rider/driver-facing screens)

These are **internal implementation details**.

Use `containsForbiddenProviderCopy()` in tests for customer-facing strings.

---

## Backend routing SSOT

```
Customer selects payment method
            ↓
Determine active service area
            ↓
Determine configured payment provider (service_areas.payment_provider)
            ↓
Route request to the correct payment adapter
            ↓
Complete payment
```

### Reference examples (backend only)

| Service area | Collection / payout adapter |
|--------------|----------------------------|
| Milton Keynes | Revolut |
| London | Stripe |
| Kenya | Flutterwave |
| Ghana | Paystack |
| Somalia | Waafi / EVC Plus |
| Uganda | MTN Mobile Money |
| Ethiopia | Telebirr |

The customer always experiences the **same ONECAB payment flow** regardless of the underlying adapter.

**Implementation:** `paymentProviders/index.ts`, `paymentMethodSSOT.ts`, `paymentGatewayStatus.ts`, `resolve-service-area`.

---

## Saved cards

Saved cards are an **ONECAB platform feature**, not a provider feature.

- Customers save payment methods to their **ONECAB account**.
- Backend stores **provider-specific tokens** securely.
- UI presents a **single unified Saved Cards** section (Wallet + booking).

### Booking flow

1. Detect service area.
2. Select configured payment provider.
3. Use matching provider token for the saved payment method.
4. If no token exists for that provider → securely tokenize once, store for reuse.
5. Future payments reuse automatically.

Customers never need to know which adapter holds the token.

**Phase 2:** Revolut tokenisation — see `docs/REVOLUT_SAVED_CARD_VAULT_SSOT.md`.

---

## Driver payouts

Driver payouts are **provider-neutral**. Backend selects the payout adapter from the driver's **service area**.

| Service area | Payout adapter (example) |
|--------------|--------------------------|
| Milton Keynes | Revolut |
| Kenya | Flutterwave |
| Somalia | Waafi |
| Ghana | Paystack |

### Production rules

- **Automated payout is the production default** (weekly batches).
- **Manual payout** is ops-only for exceptional cases:
  - Failed payout recovery
  - Compliance review
  - Manual adjustment
  - Emergency intervention
- Admin must **not** manually process hundreds/thousands of weekly driver payouts.

Interim states (e.g. Revolut collection live, automated payout credentials pending) are **admin/ops visibility only** — not rider-facing.

---

## Production rules (summary)

| Rule | SSOT |
|------|------|
| Backend is SSOT | Service area + adapter registry |
| Service area → provider | `service_areas.payment_provider` |
| Customers/drivers never see provider | Customer copy from `onecabPaymentProviderSSOT.ts` |
| Saved cards = platform feature | `paymentMethodSSOT.ts` + vault per adapter |
| Wallets enabled when adapter supports | `customerPaymentWorkflow.ts` |
| Identical customer UX | Provider-neutral labels everywhere |

---

## Related modules

| Module | Role |
|--------|------|
| `shared/onecabPaymentProviderSSOT.ts` | Principles + customer-safe copy |
| `src/lib/paymentMethodSSOT.ts` | Customer payment method readiness |
| `supabase/functions/_shared/paymentMethodSSOT.ts` | Edge/admin digital methods payload |
| `supabase/functions/_shared/paymentGatewayStatus.ts` | Gateway + payout readiness |
| `src/lib/paymentRailSSOT.ts` | Rail capabilities (internal) |
| `shared/digitalFinanceSSOT.ts` | Digital-only finance rules |
