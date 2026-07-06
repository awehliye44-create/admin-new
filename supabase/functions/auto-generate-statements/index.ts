import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertServiceRole } from "../_shared/internalAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const gate = assertServiceRole(req);
  if (gate) return gate;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Fetch all active schedule configs where it's time to run
    const { data: configs, error: configError } = await supabase
      .from("statement_schedule_configs")
      .select("*")
      .eq("is_auto_generate_enabled", true)
      .neq("frequency", "manual");

    if (configError) throw configError;
    if (!configs || configs.length === 0) {
      return new Response(JSON.stringify({ message: "No active schedules" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date();
    const results: any[] = [];

    for (const config of configs) {
      // Check if it's time to run based on next_run_at
      if (config.next_run_at && new Date(config.next_run_at) > now) {
        continue; // Not time yet
      }

      // Determine period
      let periodStart: string;
      let periodEnd: string;

      if (config.statement_period_mode === "previous_month") {
        const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
        periodStart = prevMonth.toISOString().split("T")[0];
        periodEnd = lastDay.toISOString().split("T")[0];
      } else if (config.statement_period_mode === "current_month_to_date") {
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
        periodStart = firstDay.toISOString().split("T")[0];
        periodEnd = now.toISOString().split("T")[0];
      } else {
        // custom: N days back
        const daysBack = config.custom_period_days || 30;
        const start = new Date(now.getTime() - daysBack * 86400000);
        periodStart = start.toISOString().split("T")[0];
        periodEnd = now.toISOString().split("T")[0];
      }

      // Create run log entry
      const { data: logEntry } = await supabase
        .from("statement_schedule_run_log")
        .insert({
          schedule_config_id: config.id,
          status: "running",
          period_start: periodStart,
          period_end: periodEnd,
          region_id: config.scope_region_id,
          service_area_id: config.scope_service_area_id,
        })
        .select()
        .single();

      try {
        // Determine which regions to process
        let regionsToProcess: any[] = [];

        if (config.scope_type === "region" && config.scope_region_id) {
          const { data: region } = await supabase
            .from("regions")
            .select("id, currency_code")
            .eq("id", config.scope_region_id)
            .single();
          if (region) regionsToProcess = [region];
        } else if (config.scope_type === "service_area" && config.scope_service_area_id) {
          const { data: sa } = await supabase
            .from("service_areas")
            .select("id, region_id, region:regions(id, currency_code)")
            .eq("id", config.scope_service_area_id)
            .single();
          if (sa?.region) regionsToProcess = [sa.region];
        } else {
          // All regions
          const { data: allRegions } = await supabase
            .from("regions")
            .select("id, currency_code")
            .eq("status", "active");
          regionsToProcess = allRegions || [];
        }

        let totalInvoices = 0;

        for (const region of regionsToProcess) {
          const saId = config.scope_type === "service_area" ? config.scope_service_area_id : null;

          // Create statement run
          const { data: run, error: runError } = await supabase
            .from("statement_runs")
            .insert({
              period_start: periodStart,
              period_end: periodEnd,
              region_id: region.id,
              service_area_id: saId,
              currency_code: region.currency_code,
              status: "generating",
              triggered_by: "auto",
              schedule_config_id: config.id,
            })
            .select()
            .single();

          if (runError) throw runError;

          // Find drivers with ledger activity from driver_wallet_ledger
          const { data: ledgerDrivers } = await supabase
            .from("driver_wallet_ledger")
            .select("driver_id")
            .eq("currency", region.currency_code)
            .gte("created_at", periodStart)
            .lte("created_at", periodEnd + "T23:59:59Z");

          let uniqueDriverIds = [...new Set((ledgerDrivers || []).map((d: any) => d.driver_id))];

          if (saId) {
            const { data: saDrivers } = await supabase
              .from("driver_service_areas")
              .select("driver_id")
              .eq("service_area_id", saId);
            const saDriverSet = new Set((saDrivers || []).map((d: any) => d.driver_id));
            uniqueDriverIds = uniqueDriverIds.filter((id) => saDriverSet.has(id));
          }

          if (uniqueDriverIds.length === 0) {
            await supabase.from("statement_runs").update({
              status: "completed",
              total_invoices: 0,
              total_amount_pence: 0,
              completed_at: new Date().toISOString(),
            }).eq("id", run.id);
            continue;
          }

          const { data: template } = await supabase
            .from("invoice_templates")
            .select("id")
            .eq("is_default", true)
            .maybeSingle();

          let runTotal = 0;
          let runInvoiceCount = 0;

          for (const driverId of uniqueDriverIds) {
            const { data: entries } = await supabase
              .from("driver_wallet_ledger")
              .select("type, amount_pence, related_trip_id")
              .eq("driver_id", driverId)
              .eq("currency", region.currency_code)
              .gte("created_at", periodStart)
              .lte("created_at", periodEnd + "T23:59:59Z");

            let grossEarnings = 0, commission = 0, bonuses = 0, penalties = 0, adjustments = 0;
            const completedTrips = new Set<string>();
            let noShowTrips = 0, lateCancelTrips = 0;

            for (const e of entries || []) {
              const amt = e.amount_pence || 0;
              switch (e.type) {
                case "TRIP_EARNING_NET": grossEarnings += amt; if (e.related_trip_id) completedTrips.add(e.related_trip_id); break;
                case "PLATFORM_COMMISSION": case "COMPANY_COMMISSION": commission += Math.abs(amt); break;
                case "BONUS": case "INCENTIVE": bonuses += amt; break;
                case "PENALTY": case "DEDUCTION": penalties += Math.abs(amt); break;
                case "ADJUSTMENT": case "REFUND_DEBIT": adjustments += amt; break;
                case "NO_SHOW_EARNING": noShowTrips++; grossEarnings += amt; break;
                case "LATE_CANCEL_EARNING": lateCancelTrips++; grossEarnings += amt; break;
                case "TIP_CREDIT": case "DRIVER_TIP_CREDIT": grossEarnings += amt; break;
              }
            }

            if (grossEarnings === 0 && commission === 0 && bonuses === 0 && penalties === 0 && adjustments === 0) {
              continue;
            }

            const netEarnings = grossEarnings - commission + bonuses - penalties + adjustments;
            const { data: invNum } = await supabase.rpc("generate_invoice_number");
            const invoiceNumber = invNum || `INV-${Date.now()}-${runInvoiceCount}`;

            // Calculate due date
            const dueDate = new Date(now.getTime() + config.due_days_after_generation * 86400000);

            const { data: driverRow } = await supabase
              .from("drivers")
              .select("first_name, last_name, driver_code, user_id")
              .eq("id", driverId)
              .maybeSingle();
            let driverDisplayName = driverRow
              ? `${driverRow.first_name ?? ""} ${driverRow.last_name ?? ""}`.trim()
              : "";
            if (!driverDisplayName && driverRow?.user_id) {
              const { data: profile } = await supabase
                .from("profiles")
                .select("full_name")
                .eq("user_id", driverRow.user_id)
                .maybeSingle();
              driverDisplayName = profile?.full_name?.trim() || "";
            }

            const { data: inv } = await supabase
              .from("invoices")
              .insert({
                invoice_number: invoiceNumber,
                statement_run_id: run.id,
                driver_id: driverId,
                driver_display_name: driverDisplayName || null,
                driver_display_code: driverRow?.driver_code ?? null,
                driver_display_email: driverRow?.email ?? null,
                template_id: template?.id || null,
                period_start: periodStart,
                period_end: periodEnd,
                region_id: region.id,
                service_area_id: saId,
                currency_code: region.currency_code,
                gross_earnings_pence: grossEarnings,
                commission_pence: commission,
                bonuses_pence: bonuses,
                penalties_pence: penalties,
                adjustments_pence: adjustments,
                net_earnings_pence: netEarnings,
                completed_trips: completedTrips.size,
                no_show_trips: noShowTrips,
                late_cancel_trips: lateCancelTrips,
                status: config.is_auto_send_enabled && config.send_mode === "immediate" ? "sent" : "draft",
                sent_at: config.is_auto_send_enabled && config.send_mode === "immediate" ? new Date().toISOString() : null,
              })
              .select()
              .single();

            if (inv) {
              const items: any[] = [
                { invoice_id: inv.id, item_type: "trip_earnings", description: `Completed trip earnings (${completedTrips.size} trips)`, amount_pence: grossEarnings, sort_order: 1 },
                { invoice_id: inv.id, item_type: "commission", description: "Platform commission", amount_pence: -commission, sort_order: 2 },
              ];
              if (bonuses > 0) items.push({ invoice_id: inv.id, item_type: "bonus", description: "Bonuses & incentives", amount_pence: bonuses, sort_order: 3 });
              if (penalties > 0) items.push({ invoice_id: inv.id, item_type: "penalty", description: "Penalties & deductions", amount_pence: -penalties, sort_order: 4 });
              if (adjustments !== 0) items.push({ invoice_id: inv.id, item_type: "adjustment", description: "Manual adjustments", amount_pence: adjustments, sort_order: 5 });

              await supabase.from("invoice_items").insert(items);

              try {
                const { generateDriverInvoicePdfOnly } = await import("../_shared/driverInvoiceService.ts");
                const pdfResult = await generateDriverInvoicePdfOnly(supabase, inv.id);
                if (!pdfResult.ok) {
                  console.warn("[auto-generate-statements] pdf_generation_failed", {
                    invoiceId: inv.id,
                    error: pdfResult.error,
                  });
                }
              } catch (pdfErr) {
                console.warn("[auto-generate-statements] pdf_generation_error", pdfErr);
              }

              runTotal += netEarnings;
              runInvoiceCount++;
            }
          }

          await supabase.from("statement_runs").update({
            status: config.is_auto_send_enabled && config.send_mode === "immediate" ? "sent" : "completed",
            total_invoices: runInvoiceCount,
            total_amount_pence: runTotal,
            completed_at: new Date().toISOString(),
          }).eq("id", run.id);

          totalInvoices += runInvoiceCount;
        }

        // Calculate next run
        let nextRun: Date;
        if (config.frequency === "monthly") {
          const genDay = config.generation_day === 0 ? 28 : config.generation_day;
          nextRun = new Date(now.getFullYear(), now.getMonth() + 1, genDay, config.send_hour, 0, 0);
        } else {
          // weekly
          nextRun = new Date(now.getTime() + 7 * 86400000);
          nextRun.setHours(config.send_hour, 0, 0, 0);
        }

        // Update config and log
        await supabase.from("statement_schedule_configs").update({
          last_run_at: now.toISOString(),
          last_run_status: "success",
          last_run_error: null,
          last_run_invoice_count: totalInvoices,
          next_run_at: nextRun.toISOString(),
        }).eq("id", config.id);

        if (logEntry) {
          await supabase.from("statement_schedule_run_log").update({
            status: "success",
            completed_at: new Date().toISOString(),
            invoice_count: totalInvoices,
            statement_run_id: null, // could link to the last run
          }).eq("id", logEntry.id);
        }

        results.push({ config_id: config.id, invoices: totalInvoices, status: "success" });
      } catch (runErr: any) {
        // Update config with failure
        await supabase.from("statement_schedule_configs").update({
          last_run_at: now.toISOString(),
          last_run_status: "failed",
          last_run_error: runErr.message,
        }).eq("id", config.id);

        if (logEntry) {
          await supabase.from("statement_schedule_run_log").update({
            status: "failed",
            completed_at: new Date().toISOString(),
            error_message: runErr.message,
          }).eq("id", logEntry.id);
        }

        results.push({ config_id: config.id, status: "failed", error: runErr.message });
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
