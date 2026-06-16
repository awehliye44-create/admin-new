import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  getPaymentRowCapturedPence,
  getTripDriverNetPence,
  getTripSettlementFarePence,
} from "../_shared/tripSettlementFinanceSSOT.ts";

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

    // Get authorization header to verify admin
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check admin role via user_roles table (NOT profiles — prevents privilege escalation)
    const { data: roleData } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();

    if (!roleData) {
      return new Response(JSON.stringify({ error: 'Admin access required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Parse query parameters
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const status = url.searchParams.get('status');
    const method = url.searchParams.get('method');
    const type = url.searchParams.get('type'); // 'payment', 'refund', or null for all
    const search = url.searchParams.get('search');
    const startDate = url.searchParams.get('from') || url.searchParams.get('startDate');
    const endDate = url.searchParams.get('to') || url.searchParams.get('endDate');
    const serviceAreaId = url.searchParams.get('service_area_id');
    const regionId = url.searchParams.get('region_id');

    const offset = (page - 1) * limit;

    // Build query
    let query = supabase
      .from('trips')
      .select(`
        id,
        trip_code,
        trip_number,
        pickup_address,
        dropoff_address,
        gross_fare_pence,
        final_fare_pence,
        capture_amount_pence,
        estimated_total_pence,
        estimated_fare,
        commission_pence,
        driver_net_pence,
        payment_method,
        payment_status,
        stripe_payment_intent_id,
        stripe_charge_id,
        refund_amount_pence,
        refund_reason,
        refunded_at,
        extras_pence,
        tip_pence,
        created_at,
        completed_at,
        status,
        driver_id,
        passenger_id,
        drivers:driver_id (
          id,
          first_name,
          last_name,
          email
        )
      `, { count: 'exact' })
      .not('payment_method', 'is', null)
      .order('completed_at', { ascending: false, nullsFirst: false });

    // Apply filters
    if (status) {
      query = query.eq('payment_status', status);
    }

    if (method) {
      query = query.eq('payment_method', method.toLowerCase());
    }

    if (serviceAreaId) {
      query = query.eq('service_area_id', serviceAreaId);
    }

    if (regionId) {
      query = query.eq('region_id', regionId);
    }

    if (type === 'refund') {
      query = query.gt('refund_amount_pence', 0);
    } else if (type === 'payment') {
      query = query.or('refund_amount_pence.is.null,refund_amount_pence.eq.0');
    }

    // Align trip list with Financial Reconciliation SSOT (completed_at window).
    if (startDate || endDate) {
      query = query.not('completed_at', 'is', null);
      if (startDate) {
        query = query.gte('completed_at', startDate);
      }
      if (endDate) {
        query = query.lte('completed_at', endDate);
      }
    }

    if (search) {
      query = query.or(`trip_code.ilike.%${search}%,trip_number.ilike.%${search}%,pickup_address.ilike.%${search}%,dropoff_address.ilike.%${search}%`);
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1);

    const { data: transactions, error, count } = await query;

    if (error) {
      console.error('Query error:', error);
      throw error;
    }

    const tripIds = (transactions ?? []).map((t: { id: string }) => t.id);
    const paymentsByTrip = new Map<string, number>();
    const ledgerNetByTrip = new Map<string, number>();

    if (tripIds.length > 0) {
      const [{ data: payments }, { data: ledgerRows }] = await Promise.all([
        supabase
          .from('payments')
          .select('trip_id, captured_amount_pence, amount_pence, status')
          .in('trip_id', tripIds),
        supabase
          .from('driver_wallet_ledger')
          .select('related_trip_id, type, amount_pence')
          .in('related_trip_id', tripIds)
          .eq('type', 'TRIP_EARNING_NET'),
      ]);

      for (const payment of payments ?? []) {
        if (!payment.trip_id) continue;
        const rowCaptured = getPaymentRowCapturedPence(payment);
        paymentsByTrip.set(
          payment.trip_id,
          (paymentsByTrip.get(payment.trip_id) ?? 0) + rowCaptured,
        );
      }

      for (const entry of ledgerRows ?? []) {
        if (!entry.related_trip_id) continue;
        ledgerNetByTrip.set(entry.related_trip_id, entry.amount_pence);
      }
    }

    // Transform data — Customer Paid uses settlement SSOT, not gross_fare_pence
    const transformedTransactions = transactions?.map((t: Record<string, unknown>) => {
      const tripId = String(t.id);
      const paymentCaptured = paymentsByTrip.get(tripId) ?? 0;
      const customerPaid = getTripSettlementFarePence(
        {
          payment_method: t.payment_method as string | null,
          payment_status: t.payment_status as string | null,
          final_fare_pence: t.final_fare_pence as number | null,
          gross_fare_pence: t.gross_fare_pence as number | null,
          capture_amount_pence: t.capture_amount_pence as number | null,
        },
        { paymentCapturedPence: paymentCaptured > 0 ? paymentCaptured : null },
      );
      const driverNet = getTripDriverNetPence({
        driver_net_pence: t.driver_net_pence as number | null,
        ledger: ledgerNetByTrip.has(tripId)
          ? [{ type: 'TRIP_EARNING_NET', amount_pence: ledgerNetByTrip.get(tripId)! }]
          : [],
      });
      const drivers = t.drivers as { first_name?: string; last_name?: string } | null;

      return {
        id: t.id,
        tripCode: t.trip_number || t.trip_code || String(t.id).substring(0, 8).toUpperCase(),
        type: (t.refund_amount_pence && (t.refund_amount_pence as number) > 0) ? 'refund' : 'payment',
        route: `${(t.pickup_address as string)?.split(',')[0] || 'Unknown'} → ${(t.dropoff_address as string)?.split(',')[0] || 'Unknown'}`,
        amount: customerPaid,
        customerPaid,
        estimatedFare: (t.estimated_total_pence as number | null)
          ?? (t.estimated_fare != null ? Math.round((t.estimated_fare as number) * 100) : 0),
        refundAmount: t.refund_amount_pence || 0,
        status: t.payment_status || 'unknown',
        method: t.payment_method || 'unknown',
        date: t.created_at,
        completedAt: t.completed_at,
        driver: drivers ? `${drivers.first_name} ${drivers.last_name}` : null,
        driverId: t.driver_id,
        customer: null,
        customerId: t.passenger_id,
        commission: t.commission_pence || 0,
        driverNet,
        extras: t.extras_pence || 0,
        tip: t.tip_pence || 0,
        stripePaymentIntentId: t.stripe_payment_intent_id,
        stripeChargeId: t.stripe_charge_id,
      };
    }) || [];

    return new Response(JSON.stringify({
      transactions: transformedTransactions,
      total: count || 0,
      page,
      limit,
      totalPages: Math.ceil((count || 0) / limit),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Error in admin-payments-list:', error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
