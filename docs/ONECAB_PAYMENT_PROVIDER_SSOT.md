# ONECAB Payment Provider SSOT

**Status:** Canonical  
**Code:** `shared/onecabPaymentProviderSSOT.ts`  
**Mirrors:** `supabase/functions/_shared/onecabPaymentProviderSSOT.ts`, `src/lib/onecabPaymentProviderSSOT.ts`, `admin-new/shared/onecabPaymentProviderSSOT.ts`

---

## Principle

The **service area** determines the payment provider. The **customer experience must remain identical** across all service areas.

Customers and drivers **must never know or choose** which payment provider is being used. That is a **backend responsibility**.

---

## Customer Payment Methods (Global)

These are standard **ONECAB features** and must be available regardless of the selected payment provider, **provided the provider supports them**:

- Card Payment
- Saved Cards
- Apple Pay
- Google Pay
- Mobile Wallets
- Pay by Bank (where supported)
- ONECAB Wallet

The UI must **never** display messages such as:

- "Provider unsupported"
- "Stripe only"
- "Revolut only"

These are internal implementation details and must **never** be exposed to customers or drivers.

All customer-facing labels must come from `CUSTOMER_PAYMENT_METHOD_LABELS` in `shared/onecabPaymentProviderSSOT.ts`.  
Guard with `containsForbiddenProviderCopy()` in tests.

---

## Backend SSOT

```
Customer selects a payment method
            ↓
Determine active service area
            ↓
Determine configured payment provider
            ↓
Route request to the correct payment adapter
            ↓
Complete payment
```

### Examples (backend only — never shown in rider/driver UI)

| Service area | Adapter |
|--------------|---------|
| Milton Keynes | Revolut |
| London | Stripe |
| Kenya | Flutterwave |
| Ghana | Paystack |
| Somalia | Waafi / EVC Plus |
| Uganda | MTN Mobile Money |
| Ethiopia | Telebirr |

The customer always experiences the **same ONECAB payment flow** regardless of the underlying provider.

**Implementation:** `service_areas.payment_provider`, `paymentProviders/index.ts`, `paymentMethodSSOT.ts`, `paymentGatewayStatus.ts`, `resolve-service-area`.

---

## Saved Cards

Saved Cards are an **ONECAB platform feature**, not a provider feature.

Customers should be able to save payment methods for their **ONECAB account**.

The backend securely manages **provider-specific payment tokens** while presenting a single unified **Saved Cards** experience to the customer.

### When the customer books

1. Detect service area.
2. Select the configured payment provider.
3. Use the matching provider token for the saved payment method.
4. If no token exists for that provider, securely tokenize the card once and store it for future use.
5. Future payments reuse the saved payment method automatically.

Customers should never need to know which provider is being used.

**Phase 2:** Revolut tokenisation — `docs/REVOLUT_SAVED_CARD_VAULT_SSOT.md`.

---

## Driver Payouts

Driver payouts must also be **provider-neutral**.

The backend determines the payout provider based on the **driver's assigned service area**.

### Examples (backend only)

| Service area | Payout adapter |
|--------------|----------------|
| Milton Keynes | Revolut |
| Kenya | Flutterwave |
| Somalia | Waafi |
| Ghana | Paystack |

### Production rules

- **Automatic payout is the production default** (weekly batches).
- **Manual payout** is available only for exceptional cases:
  - Failed payout
  - Compliance review
  - Manual adjustment
  - Emergency intervention
- The admin must **never** manually process hundreds or thousands of weekly driver payouts.

Interim states (e.g. collection live, automated payout credentials pending) are **admin/ops visibility only** — not rider- or driver-facing.

---

## Production Rules

| # | Rule |
|---|------|
| 1 | Backend is the single source of truth (SSOT). |
| 2 | Service area determines both customer payment provider and driver payout provider. |
| 3 | Customers and drivers never select or see the payment provider. |
| 4 | Saved Cards belong to the ONECAB platform and work across all supported providers through provider-specific tokenization. |
| 5 | Apple Pay, Google Pay, Mobile Wallets, and Pay by Bank are enabled automatically when supported by the configured provider. |
| 6 | The customer experience must remain identical across all service areas while the backend transparently routes payments to the correct provider. |

---

## Related modules

| Module | Role |
|--------|------|
| `shared/onecabPaymentProviderSSOT.ts` | Principles, pipelines, customer-safe copy |
| `src/lib/paymentMethodSSOT.ts` | Customer payment method + vault routing |
| `supabase/functions/_shared/paymentMethodSSOT.ts` | Edge/admin digital methods payload |
| `supabase/functions/_shared/paymentGatewayStatus.ts` | Gateway + payout readiness |
| `src/lib/paymentRailSSOT.ts` | Adapter capabilities (internal) |
| `src/lib/customerPaymentWorkflow.ts` | Workflow + auto-enable when adapter supports |
| `shared/digitalFinanceSSOT.ts` | Digital-only finance rules |
