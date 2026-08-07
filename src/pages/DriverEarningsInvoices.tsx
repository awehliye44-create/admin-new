/**
 * REPORTS → Driver Earnings Invoices
 *
 * Surfaces the existing driver earnings statement pipeline (Driver Wallet Ledger SSOT,
 * admin-driver-invoice, statement schedule) under Reports with configurable N-month cadence.
 * Does not invent a second invoice design — reuses driverInvoiceHtml/Pdf + Invoices list.
 */
import { Link } from "react-router-dom";
import { AdminLayout } from "@/components/layout/AdminLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText, CalendarClock, Wallet, ExternalLink } from "lucide-react";
import StatementScheduleConfig from "@/components/statements/StatementScheduleConfig";
import { FinanceSsotOperationalNotice } from "@/components/finance/FinanceSSOTBadge";

export default function DriverEarningsInvoices() {
  return (
    <AdminLayout>
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Driver Earnings Invoices</h1>
          <p className="text-muted-foreground mt-1 max-w-3xl">
            Periodic driver earnings invoices/statements from the Driver Wallet Ledger SSOT.
            Configure cadence (including every N months), generate, preview, and email using the
            existing approved driver invoice design.
          </p>
        </div>

        <FinanceSsotOperationalNotice />

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4" /> Ledger SSOT
              </CardTitle>
              <CardDescription>
                Totals use eligible net earning ledger credits only — not customer fare or payout totals.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm">
                <Link to="/driver-wallet-ledger">
                  Open Driver Wallet Ledger <ExternalLink className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4" /> Documents
              </CardTitle>
              <CardDescription>
                Generate, download, and resend driver earnings invoices for a chosen period.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm">
                <Link to="/invoices">
                  Open invoice list <ExternalLink className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarClock className="h-4 w-4" /> Batch runs
              </CardTitle>
              <CardDescription>
                Manual and scheduled statement runs with audit history.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline" size="sm">
                <Link to="/statement-runs">
                  Open statement runs <ExternalLink className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Schedule configuration</CardTitle>
            <CardDescription>
              Enable automation, set interval in months (example: 8), scope by region/service area,
              and control automatic email delivery. Disabled schedules produce no automatic reports.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StatementScheduleConfig />
          </CardContent>
        </Card>
      </div>
    </AdminLayout>
  );
}
