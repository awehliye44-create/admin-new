# Revolut saved card vault / tokenisation SSOT

**Status:** Not implemented (Phase 2)  
**Gate flag:** `REVOLUT_SAVE_CARD_TOKENIZATION_READY = false`  
**Repos:** `onecab-comfy-ride`, `admin-new`, edge `_shared/paymentMethodSSOT.ts`

## Product rule

Saved payment methods are **provider-neutral ONECAB functionality**. In Revolut service areas, saved cards must use **Revolut tokenisation/vault only** — never Stripe SetupIntent / `list-saved-cards`.

Until Revolut vault ships, admin readiness = **Not implemented for Revolut yet** (not “Provider unsupported”). Customer app hides saved-card UI.

## Scope

| Layer | Deliverable |
|-------|-------------|
| Edge | `list-revolut-saved-cards`, `setup-revolut-card`, `delete-revolut-saved-card` |
| DB | `customer_revolut_payment_methods` (or provider-neutral `customer_saved_payment_methods` with `provider=revolut`) |
| Admin | Enable saved-card toggle when `REVOLUT_SAVE_CARD_TOKENIZATION_READY=true` |
| Customer | Revolut card sheet in Wallet + SelectVehicle; no Stripe endpoints |

## Acceptance

- [ ] Revolut Merchant API tokenisation documented (sandbox + live)
- [ ] Save / list / delete endpoints deployed
- [ ] `REVOLUT_SAVE_CARD_TOKENIZATION_READY` flipped to `true` in SSOT only after E2E proof
- [ ] Admin saved card readiness → Live
- [ ] Customer Wallet shows Revolut saved cards (max 2, same policy as Stripe)
- [ ] No `list-saved-cards` / `setup-card` calls in Revolut service areas

## References

- `supabase/functions/_shared/paymentMethodSSOT.ts` — `resolveSavedCardMethodRow`
- `src/lib/revolutSavedCards.ts` — customer gate
- `supabase/functions/_shared/stripeRetirementGuard.ts` — blocks Stripe paths in Revolut areas
