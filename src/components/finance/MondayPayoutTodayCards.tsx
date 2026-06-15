import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrencySymbol } from "@/lib/regionSettings";
import { AlertTriangle, ArrowDownLeft, Banknote, CheckCircle2, Clock, XCircle } from "lucide-react";
import type { MondayPayoutTodayCards } from "@/hooks/useMondayPayoutDiagnostics";

function fmt(pence: number, currencyCode: string): string {
  const cc = (currencyCode || "gbp").toLowerCase();
  return `${getCurrencySymbol(cc)}${(pence / 100).toFixed(2)}`;
}

export function MondayPayoutTodayCards({
  cards,
  currencyCode,
  isLoading,
}: {
  cards: MondayPayoutTodayCards | undefined;
  currencyCode: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Card key={i} className="h-[100px] animate-pulse" />
        ))}
      </div>
    );
  }

  if (!cards) return null;

  const items = [
    {
      title: "ONECAB Commission Recovered Today",
      value: cards.onecab_commission_recovered_pence,
      icon: <Banknote className="h-4 w-4 text-emerald-600" />,
    },
    {
      title: "Driver Payout Sent Today",
      value: cards.driver_payout_sent_pence,
      icon: <CheckCircle2 className="h-4 w-4 text-green-600" />,
    },
    {
      title: "Driver Payout Failed Today",
      value: cards.driver_payout_failed_pence,
      icon: <XCircle className="h-4 w-4 text-destructive" />,
      destructive: cards.driver_payout_failed_pence > 0,
    },
    {
      title: "Driver Payout Pending Today",
      value: cards.driver_payout_pending_pence,
      icon: <Clock className="h-4 w-4 text-amber-600" />,
    },
    {
      title: "Returned to Wallet Today",
      value: cards.returned_to_wallet_pence,
      icon: <ArrowDownLeft className="h-4 w-4 text-blue-600" />,
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
      {items.map((item) => (
        <Card
          key={item.title}
          className={item.destructive ? "border-destructive/40" : undefined}
        >
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-medium leading-tight">{item.title}</CardTitle>
            {item.icon}
          </CardHeader>
          <CardContent>
            <div className={`text-xl font-bold ${item.destructive ? "text-destructive" : ""}`}>
              {fmt(item.value, currencyCode)}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function PartialSettlementAlert({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm flex items-start gap-2">
      <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
      <div>
        <p className="font-medium text-amber-800 dark:text-amber-200">
          PARTIAL_SETTLEMENT — {count} driver{count === 1 ? "" : "s"}
        </p>
        <p className="text-amber-700 dark:text-amber-300 mt-1">
          ONECAB commission was recovered, but driver payout did not complete.
        </p>
      </div>
    </div>
  );
}
