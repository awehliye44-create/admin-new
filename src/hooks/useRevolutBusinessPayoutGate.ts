import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  evaluateRevolutBusinessPayoutExecutionGate,
  type RevolutBusinessPayoutExecutionGate,
} from "../../shared/revolutBusinessOAuthSSOT.ts";

type RevolutBusinessDiagnostics = {
  oauth_connected?: boolean;
  token_valid?: boolean;
  oauth_scopes_granted?: string[];
  live_payout_execution_enabled?: boolean;
  accounts_list_succeeded?: boolean;
  selected_source_account_ok?: boolean | null;
  gbp_balance_pence?: number | null;
};

function buildGate(diag: RevolutBusinessDiagnostics | null | undefined): RevolutBusinessPayoutExecutionGate {
  return evaluateRevolutBusinessPayoutExecutionGate({
    oauth_connected: Boolean(diag?.oauth_connected),
    token_valid: Boolean(diag?.token_valid),
    oauth_scopes_granted: diag?.oauth_scopes_granted ?? [],
    live_payout_execution_enabled: Boolean(diag?.live_payout_execution_enabled),
    accounts_list_succeeded: Boolean(diag?.accounts_list_succeeded),
    selected_source_account_ok: diag?.selected_source_account_ok ?? null,
    live_balance_pence: diag?.gbp_balance_pence ?? null,
  });
}

export function useRevolutBusinessPayoutGate() {
  const query = useQuery({
    queryKey: ["revolut-business-payout-gate"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("admin-revolut-business-oauth", {
        body: { action: "diagnostics", include_accounts: true, probe_egress: false },
      });
      if (error) throw error;
      return data as RevolutBusinessDiagnostics;
    },
    staleTime: 30_000,
    retry: 1,
  });

  const gate = useMemo(() => buildGate(query.data), [query.data]);

  return {
    gate,
    diag: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
