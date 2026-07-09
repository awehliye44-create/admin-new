import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PaymentProviderId =
  | "stripe"
  | "checkout_com"
  | "adyen"
  | "worldpay"
  | "braintree"
  | "sifalo_pay"
  | "waafi_pay"
  | "sahal_pay"
  | "intasend"
  | "paystack"
  | "flutterwave"
  | "pesapal"
  | "hubtel"
  | "dpo_pay"
  | "noda"
  | "revolut";

export type ProviderEnvironment = "test" | "live";

export type ProviderCardStatus =
  | "not_configured"
  | "connected"
  | "error"
  | "live"
  | "test";

export interface ProviderSecretsMasked {
  publishable_key: string | null;
  secret_key: string | null;
  webhook_secret: string | null;
  merchant_id?: string | null;
}

export interface WebhookEventRow {
  event_id: string;
  event_type: string;
  status: string;
  processed_at: string;
  error: string | null;
}

export interface WebhookHealth {
  endpoint_url: string;
  status: "healthy" | "failing" | "not_configured";
  last_received_at: string | null;
  success_count_24h: number;
  failure_count_24h: number;
  last_successful_event: { event_type: string; at: string } | null;
  last_failed_event: { event_type: string; at: string; error: string | null } | null;
  last_error_message: string | null;
  retry_count: number;
  recent_events: WebhookEventRow[];
  monitored_events: string[];
}

export type BookingAdapterStatus = "live" | "not_implemented" | "not_configured";
export type PayoutAdapterStatus = "live" | "not_implemented" | "not_configured";

export interface PaymentProviderCard {
  provider: PaymentProviderId;
  display_name: string;
  status: ProviderCardStatus;
  mode: ProviderEnvironment;
  is_enabled: boolean;
  is_primary: boolean;
  api_key_status: "added" | "missing";
  webhook_status: "healthy" | "failing" | "not_configured";
  webhook_secret_status?: "added" | "missing";
  credentials_ready?: boolean;
  booking_adapter_live?: boolean;
  booking_adapter_status?: BookingAdapterStatus;
  payout_adapter_live?: boolean;
  payout_adapter_status?: PayoutAdapterStatus;
  last_webhook_received: string | null;
  last_successful_event: { event_type: string; at: string } | null;
  last_failed_event: { event_type: string; at: string; error?: string | null } | null;
  connect_enabled: boolean | null;
  apple_pay_enabled: boolean | null;
  google_pay_enabled: boolean | null;
  webhook_endpoint_url: string | null;
  secrets: ProviderSecretsMasked;
  webhook_health: WebhookHealth | null;
  warnings: string[];
  last_connection_test_at: string | null;
  last_error_message: string | null;
}

export interface PaymentProvidersResponse {
  active_provider: PaymentProviderId;
  providers: PaymentProviderCard[];
  global_warnings: string[];
}

export async function invokePaymentProviders(
  method: "GET" | "PATCH" | "POST",
  options?: {
    action?: string;
    body?: Record<string, unknown>;
    service_area_id?: string;
  },
) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Not authenticated");

  const params = new URLSearchParams();
  if (options?.action) params.set("action", options.action);
  if (options?.service_area_id) params.set("service_area_id", options.service_area_id);
  const query = params.toString() ? `?${params.toString()}` : "";
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-payment-providers${query}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "Request failed");
  return json;
}

export function usePaymentProviders() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["payment-providers"],
    queryFn: () => invokePaymentProviders("GET") as Promise<PaymentProvidersResponse>,
    staleTime: 60_000,
    // No auto-poll — config rarely changes; mutations invalidate on save.
  });


  const updateProvider = useMutation({
    mutationFn: (body: Record<string, unknown>) => invokePaymentProviders("PATCH", { body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["payment-providers"] }),
  });

  const saveSecrets = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      invokePaymentProviders("POST", { action: "save-secrets", body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["payment-providers"] }),
  });

  const testConnection = useMutation({
    mutationFn: (body: { provider: PaymentProviderId; environment: ProviderEnvironment }) =>
      invokePaymentProviders("POST", { action: "test-connection", body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["payment-providers"] }),
  });

  return { ...query, updateProvider, saveSecrets, testConnection };
}
