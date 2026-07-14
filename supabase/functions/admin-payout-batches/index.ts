import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region-id, x-service-area-id',
};

async function resolveRegionId(
  supabase: ReturnType<typeof createClient>,
  regionId: string | null,
  serviceAreaId: string | null,
): Promise<string | null> {
  if (regionId) return regionId;
  if (!serviceAreaId) return null;

  const { data } = await supabase
    .from('service_areas')
    .select('region_id')
    .eq('id', serviceAreaId)
    .maybeSingle();

  return data?.region_id ?? null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(req.url);
    let bodyParams: Record<string, string> = {};
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (body && typeof body === 'object') {
          bodyParams = body as Record<string, string>;
        }
      } catch {
        // ignore empty body
      }
    }

    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const kind = url.searchParams.get('kind');
    const status = url.searchParams.get('status');
    const rawRegionId = url.searchParams.get('region_id')
      || bodyParams.region_id
      || req.headers.get('x-region-id');
    const rawServiceAreaId = url.searchParams.get('service_area_id')
      || bodyParams.service_area_id
      || req.headers.get('x-service-area-id');
    const offset = (page - 1) * limit;

    const scopeRequested = !!(rawRegionId || rawServiceAreaId);
    const regionId = await resolveRegionId(supabase, rawRegionId, rawServiceAreaId);

    // Caller scoped to a service area — never fall back to global totals on bad/missing region.
    if (scopeRequested && !regionId) {
      return new Response(JSON.stringify({
        batches: [],
        summary: {
          totalBatches: 0,
          totalPaidOut: 0,
          totalPaidOutBatches: 0,
          pendingBatches: 0,
          failedBatches: 0,
          availableForPayout: 0,
          driversReadyForPayout: 0,
          currencyCode: '',
          regionId: null,
        },
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Resolve currency from regions table when a region scope is active
    let regionCurrency = '';
    if (regionId) {
      const { data: regionRow } = await supabase
        .from('regions')
        .select('currency_code')
        .eq('id', regionId)
        .maybeSingle();
      regionCurrency = regionRow?.currency_code || '';
    }

    let batchQuery = supabase
      .from('payout_batches')
      .select('id,kind,run_date,status,total_drivers,total_amount_pence,successful_payouts,failed_payouts,notes,created_at,completed_at,schedule_occurrence_key,schedule_id,scheduled_local_at,scheduled_utc_at,timezone,currency,eligible_driver_count,service_area_id', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (kind) batchQuery = batchQuery.eq('kind', kind);
    if (status) batchQuery = batchQuery.eq('status', status);
    batchQuery = batchQuery.range(offset, offset + limit - 1);

    const financialPromise = regionId
      ? supabase
          .from('driver_financial_summary')
          .select('driver_id, total_payouts_sent, available_for_payout, net_available_for_payout, reserved_cashout_pence, currency_code, region_id')
          .eq('region_id', regionId)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null });

    const [batchResult, financialResult] = await Promise.all([
      batchQuery,
      financialPromise,
    ]);

    if (batchResult.error) throw batchResult.error;
    if (financialResult.error) throw financialResult.error;

    const batches = batchResult.data || [];
    const count = batchResult.count;
    const financialRows = regionId ? (financialResult.data || []) : [];

    const batchIds = batches.map(b => b.id);
    const { data: allItems } = batchIds.length > 0 ? await supabase
      .from('payout_items')
      .select('id,batch_id,driver_id,amount_pence,status,execution_status,stripe_transfer_id,stripe_payout_id,error_message,created_at,completed_at,payout_destination_id,provider_request_id,wallet_snapshot_available_pence,drivers:driver_id(first_name,last_name,region_id)')
      .in('batch_id', batchIds) : { data: [] };

    const filteredRegionDriverIds = regionId
      ? new Set(financialRows.map(d => d.driver_id))
      : null;

    const itemsByBatch: Record<string, any[]> = {};
    allItems?.forEach((item: any) => {
      if (filteredRegionDriverIds && !filteredRegionDriverIds.has(item.driver_id)) return;
      if (!itemsByBatch[item.batch_id]) itemsByBatch[item.batch_id] = [];
      itemsByBatch[item.batch_id].push(item);
    });

    const transformedBatches = batches.flatMap(batch => {
      const batchItems = itemsByBatch[batch.id] || [];
      if (regionId && batchItems.length === 0) return [];
      return [{
        id: batch.id,
        kind: batch.kind,
        runDate: batch.run_date,
        status: batch.status,
        statusLabel: String(batch.status) === 'BLOCKED_EXECUTION_DISABLED'
          ? 'Execution disabled'
          : batch.status,
        scheduleOccurrenceKey: batch.schedule_occurrence_key ?? null,
        scheduleId: batch.schedule_id ?? null,
        scheduledLocalAt: batch.scheduled_local_at ?? null,
        scheduledUtcAt: batch.scheduled_utc_at ?? null,
        timezone: batch.timezone ?? null,
        currency: batch.currency ?? null,
        eligibleDriverCount: batch.eligible_driver_count ?? batch.total_drivers,
        paidClaim: false,
        totalDrivers: regionId ? batchItems.length : batch.total_drivers,
        totalAmount: regionId
          ? batchItems.reduce((sum: number, item: any) => sum + (item.amount_pence || 0), 0)
          : batch.total_amount_pence,
        successfulPayouts: regionId
          ? batchItems.filter((item: any) => item.status === 'completed' || item.status === 'PAID').length
          : batch.successful_payouts,
        failedPayouts: regionId
          ? batchItems.filter((item: any) => item.status === 'failed' || item.status === 'FAILED').length
          : batch.failed_payouts,
        notes: batch.notes,
        createdAt: batch.created_at,
        completedAt: batch.completed_at,
        items: batchItems.map((item: any) => ({
          id: item.id,
          driverId: item.driver_id,
          driverName: item.drivers ? `${item.drivers.first_name} ${item.drivers.last_name}` : null,
          amount: item.amount_pence,
          status: item.execution_status || item.status,
          statusLabel: String(item.execution_status || item.status) === 'BLOCKED_EXECUTION_DISABLED'
            ? 'Execution disabled'
            : (item.execution_status || item.status),
          stripeTransferId: item.stripe_transfer_id,
          stripePayoutId: item.stripe_payout_id,
          providerPaymentId: null,
          errorMessage: item.error_message,
          createdAt: item.created_at,
          completedAt: item.completed_at,
        })),
      }];
    });

    const unifiedTotalPayouts = regionId
      ? financialRows.reduce((s, d) => s + Number(d.total_payouts_sent || 0), 0)
      : 0;
    const unifiedAvailablePayout = regionId
      ? financialRows.reduce((s, d) => s + Number((d.net_available_for_payout ?? d.available_for_payout) || 0), 0)
      : 0;
    const driversReadyForPayout = regionId
      ? financialRows.filter(d => Number((d.net_available_for_payout ?? d.available_for_payout) || 0) > 0).length
      : 0;
    const dominantCurrency = regionId ? regionCurrency : '';

    const summary = {
      totalBatches: regionId ? transformedBatches.length : (count || 0),
      totalPaidOut: unifiedTotalPayouts,
      totalPaidOutBatches: transformedBatches
        .filter(b => b.status === 'completed')
        .reduce((sum, b) => sum + (b.totalAmount || 0), 0),
      pendingBatches: transformedBatches.filter(b => b.status === 'pending' || b.status === 'processing').length,
      failedBatches: transformedBatches.filter(b => b.status === 'failed').length,
      availableForPayout: unifiedAvailablePayout,
      driversReadyForPayout,
      currencyCode: dominantCurrency,
      regionId: regionId || null,
    };

    return new Response(JSON.stringify({
      batches: transformedBatches,
      summary,
      total: regionId ? transformedBatches.length : (count || 0),
      page,
      limit,
      totalPages: Math.ceil((regionId ? transformedBatches.length : (count || 0)) / limit),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-payout-batches:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
