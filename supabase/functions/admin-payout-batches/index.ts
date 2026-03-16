import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
      .single();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const kind = url.searchParams.get('kind');
    const status = url.searchParams.get('status');

    const offset = (page - 1) * limit;

    let query = supabase
      .from('payout_batches')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (kind) query = query.eq('kind', kind);
    if (status) query = query.eq('status', status);
    query = query.range(offset, offset + limit - 1);

    const { data: batches, count, error } = await query;
    if (error) throw error;

    // Get items for each batch
    const batchIds = batches?.map(b => b.id) || [];
    const { data: allItems } = batchIds.length > 0 ? await supabase
      .from('payout_items')
      .select(`
        *,
        drivers:driver_id (
          id, first_name, last_name, email
        )
      `)
      .in('batch_id', batchIds) : { data: [] };

    const itemsByBatch: Record<string, any[]> = {};
    allItems?.forEach((item: any) => {
      if (!itemsByBatch[item.batch_id]) itemsByBatch[item.batch_id] = [];
      itemsByBatch[item.batch_id].push(item);
    });

    const transformedBatches = batches?.map(batch => ({
      id: batch.id,
      kind: batch.kind,
      runDate: batch.run_date,
      status: batch.status,
      totalDrivers: batch.total_drivers,
      totalAmount: batch.total_amount_pence,
      successfulPayouts: batch.successful_payouts,
      failedPayouts: batch.failed_payouts,
      notes: batch.notes,
      createdAt: batch.created_at,
      completedAt: batch.completed_at,
      items: itemsByBatch[batch.id]?.map((item: any) => ({
        id: item.id,
        driverId: item.driver_id,
        driverName: item.drivers ? `${item.drivers.first_name} ${item.drivers.last_name}` : null,
        amount: item.amount_pence,
        status: item.status,
        stripeTransferId: item.stripe_transfer_id,
        stripePayoutId: item.stripe_payout_id,
        errorMessage: item.error_message,
        createdAt: item.created_at,
        completedAt: item.completed_at,
      })) || [],
    })) || [];

    // ── Unified stats from driver_financial_summary ──
    const { data: financialRows } = await supabase
      .from('driver_financial_summary')
      .select('total_payouts_sent, wallet_balance, available_for_payout');

    const unifiedTotalPayouts = financialRows?.reduce((s, d) => s + Number(d.total_payouts_sent || 0), 0) || 0;
    const unifiedAvailablePayout = financialRows?.reduce((s, d) => s + Number(d.available_for_payout || 0), 0) || 0;
    const driversReadyForPayout = financialRows?.filter(d => Number(d.available_for_payout || 0) > 0).length || 0;

    // Batch-level summary
    const { data: summaryData } = await supabase
      .from('payout_batches')
      .select('status, total_amount_pence');

    const summary = {
      totalBatches: summaryData?.length || 0,
      totalPaidOut: unifiedTotalPayouts, // From unified view
      totalPaidOutBatches: summaryData?.filter(b => b.status === 'completed')
        .reduce((sum, b) => sum + (b.total_amount_pence || 0), 0) || 0,
      pendingBatches: summaryData?.filter(b => b.status === 'pending' || b.status === 'processing').length || 0,
      failedBatches: summaryData?.filter(b => b.status === 'failed').length || 0,
      availableForPayout: unifiedAvailablePayout,
      driversReadyForPayout,
    };

    return new Response(JSON.stringify({
      batches: transformedBatches,
      summary,
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
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
