import { useQuery } from "@tanstack/react-query";
import { Activity, Code, Key, Link2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";

interface IntegrationRow {
  id: string;
  status: string;
}

interface ApiKeyRow {
  id: string;
  is_active: boolean;
}

export function IntegrationsOverviewCards() {
  const { data: integrations = [] } = useQuery({
    queryKey: ["integrations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("admin_settings")
        .select("*")
        .eq("setting_key", "integrations")
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return (data?.setting_value as unknown as IntegrationRow[]) || [];
    },
  });

  const { data: apiKeys = [] } = useQuery({
    queryKey: ["api-keys"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("admin_settings")
        .select("*")
        .eq("setting_key", "api_keys")
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return (data?.setting_value as unknown as ApiKeyRow[]) || [];
    },
  });

  const activeIntegrations = integrations.filter((i) => i.status === "active").length;
  const activeApiKeys = apiKeys.filter((k) => k.is_active).length;

  return (
    <div className="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Integrations</CardTitle>
          <Link2 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{integrations.length}</div>
          <p className="text-xs text-muted-foreground">{activeIntegrations} active</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">API Keys</CardTitle>
          <Key className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{apiKeys.length}</div>
          <p className="text-xs text-muted-foreground">{activeApiKeys} active</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Rate Limit</CardTitle>
          <Activity className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">10k/hr</div>
          <p className="text-xs text-muted-foreground">Default limit</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">API Version</CardTitle>
          <Code className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">v1.0</div>
          <p className="text-xs text-muted-foreground">Current version</p>
        </CardContent>
      </Card>
    </div>
  );
}
