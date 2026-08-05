import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { errorResponse } from "./security.ts";

/**
 * Authenticate a driver from the Authorization header.
 * Returns the driver's UUID (drivers.id) or an error Response.
 */
export async function authenticateDriver(
  req: Request
): Promise<{ driverId: string; userId: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse(
      "UNAUTHORIZED",
      "Missing or invalid authorization header",
      401,
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const token = authHeader.replace("Bearer ", "");
  // Prefer getUser (network-verified) over local JWT decode.
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return errorResponse("UNAUTHORIZED", "Invalid or expired token", 401);
  }

  const userId = userData.user.id;

  // Look up the driver record for this authenticated user
  const serviceClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: driver, error: driverError } = await serviceClient
    .from("drivers")
    .select("id")
    .eq("user_id", userId)
    .single();

  if (driverError || !driver) {
    return errorResponse(
      "FORBIDDEN",
      "No driver profile found for this user",
      403,
    );
  }

  return { driverId: driver.id, userId };
}
