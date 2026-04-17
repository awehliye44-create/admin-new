/**
 * CustomerOfferCard — original ONECAB design.
 * Intentionally NOT styled like Bolt or any competitor. Uses ONECAB's
 * gold-on-navy palette via semantic tokens (no hardcoded colors).
 *
 * This component is shared with the customer app codebase as a reference
 * implementation. Drop it into the customer app and feed it any Offer row.
 */
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, Sparkles } from "lucide-react";
import type { Offer } from "@/hooks/useOffers";

interface Props {
  offer: Offer;
  onView?: (offer: Offer) => void;
  onDismiss?: (offer: Offer) => void;
}

function formatDiscount(o: Offer): string {
  if (o.offer_type === "percent_discount") return `${Number(o.discount_value)}% off`;
  return `${currencySymbol(o.currency)}${Number(o.discount_value).toFixed(0)} off`;
}

function currencySymbol(code: string): string {
  switch (code?.toUpperCase()) {
    case "GBP": return "£";
    case "EUR": return "€";
    case "USD": return "$";
    default: return code + " ";
  }
}

export function CustomerOfferCard({ offer, onView, onDismiss }: Props) {
  return (
    <Card
      className="relative overflow-hidden border-primary/20 bg-gradient-to-br from-card to-secondary/40 p-4 shadow-sm"
      data-offer-id={offer.id}
    >
      {/* Decorative accent — not a copy of any competitor's UI */}
      <div className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-primary/15 blur-2xl" />

      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold leading-tight text-foreground">
              {offer.banner_title}
            </h3>
            {offer.badge_text && (
              <Badge variant="default" className="bg-primary text-primary-foreground">
                {offer.badge_text}
              </Badge>
            )}
          </div>
          {offer.banner_subtitle && (
            <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
              {offer.banner_subtitle}
            </p>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-lg font-bold text-primary">{formatDiscount(offer)}</span>
            <Button
              size="sm"
              variant="default"
              onClick={() => onView?.(offer)}
              className="shrink-0"
            >
              {offer.cta_text}
            </Button>
          </div>
        </div>

        {onDismiss && (
          <button
            type="button"
            aria-label="Dismiss offer"
            onClick={() => onDismiss(offer)}
            className="-mr-1 -mt-1 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </Card>
  );
}
