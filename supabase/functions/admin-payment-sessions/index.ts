import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/adminPaymentGate.ts";
import { handleAdminPaymentSessions } from "./handler.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  return await handleAdminPaymentSessions(req);
});
