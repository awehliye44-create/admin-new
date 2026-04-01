// Unified Lost Property Edge Function - handles all actions via ?action= query param
import {
  LP_CORS,
  jsonResponse,
  errorResp,
  authenticateCaller,
  requireAdmin,
  getServiceClient,
  getCustomerId,
  getDriverId,
  insertSystemMessage,
  verifyChatOpen,
} from "../_shared/lostPropertyHelpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: LP_CORS });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    switch (action) {
      case "create_case": return await createCase(req);
      case "send_message": return await sendMessage(req);
      case "driver_mark_found": return await driverMarkFound(req);
      case "driver_mark_not_found": return await driverMarkNotFound(req);
      case "customer_confirm": return await customerConfirm(req);
      case "customer_reject": return await customerReject(req);
      case "customer_select_return_method": return await customerSelectReturnMethod(req);
      case "create_return_booking": return await createReturnBooking(req);
      case "driver_accept_return": return await driverAcceptReturn(req);
      case "driver_decline_return": return await driverDeclineReturn(req);
      case "admin_send_message": return await adminSendMessage(req);
      case "admin_open_case": return await adminOpenCase(req);
      case "admin_reopen_case": return await adminReopenCase(req);
      case "admin_close_case": return await adminCloseCase(req);
      case "admin_lock_chat": return await adminLockChat(req);
      case "admin_unlock_chat": return await adminUnlockChat(req);
      case "admin_mark_viewed": return await adminMarkViewed(req);
      case "cleanup_photos": return await cleanupPhotos(req);
      case "expire_chats": return await expireChats(req);
      case "admin_unread_count": return await adminUnreadCount(req);
      default: return errorResp(`Unknown action: ${action}`, 400);
    }
  } catch (err: any) {
    console.error(`[lost-property] ${action} error:`, err);
    return errorResp(err.message || "Internal error", 500);
  }
});

// ==================== CASE CREATION ====================
async function createCase(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const body = await req.json();
  const { trip_id, item_category, item_description, photos } = body;
  if (!trip_id || !item_category || !item_description) {
    return errorResp("trip_id, item_category, and item_description are required");
  }

  const sb = getServiceClient();

  // Verify trip is completed and belongs to this customer
  const customerId = await getCustomerId(auth.userId);
  if (!customerId) return errorResp("Customer profile not found", 403);

  const { data: trip } = await sb
    .from("trips")
    .select("id, status, driver_id, service_area_id, passenger_id")
    .eq("id", trip_id)
    .single();

  if (!trip) return errorResp("Trip not found", 404);
  if (trip.status !== "completed") return errorResp("Can only report lost property for completed trips");
  if (trip.passenger_id !== customerId) return errorResp("Trip does not belong to you", 403);
  if (!trip.driver_id) return errorResp("Trip has no assigned driver");
  if (!trip.service_area_id) return errorResp("Trip has no service area");

  // Check for existing open case
  const { data: existing } = await sb
    .from("lost_property_cases")
    .select("id")
    .eq("trip_id", trip_id)
    .not("status", "in", "(CLOSED,closed)")
    .limit(1);
  if (existing && existing.length > 0) return errorResp("An open case already exists for this trip");

  // Generate case number
  const caseNumber = `LP-${Date.now().toString(36).toUpperCase()}`;
  const now = new Date();
  const chatExpiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);

  const { data: newCase, error } = await sb
    .from("lost_property_cases")
    .insert({
      case_number: caseNumber,
      trip_id,
      customer_id: customerId,
      driver_id: trip.driver_id,
      region_id: trip.service_area_id, // legacy column — use service_area_id
      service_area_id: trip.service_area_id,
      item_category,
      item_description,
      photos: photos || [],
      status: "NEW",
      chat_enabled: true,
      chat_opened_at: now.toISOString(),
      chat_expires_at: chatExpiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) throw error;

  await insertSystemMessage(newCase.id, "Lost property case created. The driver has been notified.");

  // Auto-transition to SENT_TO_DRIVER
  await sb
    .from("lost_property_cases")
    .update({ status: "SENT_TO_DRIVER" })
    .eq("id", newCase.id);

  return jsonResponse({ success: true, case: newCase });
}

// ==================== SEND MESSAGE ====================
async function sendMessage(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id, message, attachments } = await req.json();
  if (!case_id || !message) return errorResp("case_id and message are required");

  const chatErr = await verifyChatOpen(case_id);
  if (chatErr) return errorResp(chatErr);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("customer_id, driver_id")
    .eq("id", case_id)
    .single();
  if (!lpc) return errorResp("Case not found", 404);

  // Determine sender type
  let senderType: string;
  const customerId = await getCustomerId(auth.userId);
  const driverId = await getDriverId(auth.userId);

  if (customerId && lpc.customer_id === customerId) senderType = "RIDER";
  else if (driverId && lpc.driver_id === driverId) senderType = "DRIVER";
  else return errorResp("You are not a participant in this case", 403);

  const { data: msg, error } = await sb
    .from("lost_property_messages")
    .insert({
      case_id,
      sender_type: senderType,
      sender_id: auth.userId,
      message,
      attachments: attachments || [],
    })
    .select()
    .single();

  if (error) throw error;
  return jsonResponse({ success: true, message: msg });
}

// ==================== DRIVER: MARK FOUND ====================
async function driverMarkFound(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id, found_item_photos } = await req.json();
  if (!case_id) return errorResp("case_id is required");
  if (!found_item_photos || !Array.isArray(found_item_photos) || found_item_photos.length === 0) {
    return errorResp("At least one photo is required when marking item as found");
  }

  const driverId = await getDriverId(auth.userId);
  if (!driverId) return errorResp("Driver profile not found", 403);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("id, driver_id, status")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);
  if (lpc.driver_id !== driverId) return errorResp("Not your case", 403);
  if (!["NEW", "SENT_TO_DRIVER"].includes(lpc.status)) {
    return errorResp("Case is not in a state to mark as found");
  }

  const { error } = await sb
    .from("lost_property_cases")
    .update({
      status: "AWAITING_CUSTOMER_CONFIRMATION",
      found_item_photos,
      driver_responded_at: new Date().toISOString(),
      item_found_at: new Date().toISOString(),
    })
    .eq("id", case_id);

  if (error) throw error;

  await insertSystemMessage(case_id, "Driver has confirmed finding the item and uploaded photos for verification.");
  return jsonResponse({ success: true });
}

// ==================== DRIVER: MARK NOT FOUND ====================
async function driverMarkNotFound(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const driverId = await getDriverId(auth.userId);
  if (!driverId) return errorResp("Driver profile not found", 403);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("id, driver_id, status")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);
  if (lpc.driver_id !== driverId) return errorResp("Not your case", 403);

  const { error } = await sb
    .from("lost_property_cases")
    .update({
      status: "DRIVER_NOT_FOUND",
      driver_responded_at: new Date().toISOString(),
    })
    .eq("id", case_id);

  if (error) throw error;

  await insertSystemMessage(case_id, "Driver has reported the item was not found.");
  return jsonResponse({ success: true });
}

// ==================== CUSTOMER: CONFIRM FOUND ITEM ====================
async function customerConfirm(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const customerId = await getCustomerId(auth.userId);
  if (!customerId) return errorResp("Customer profile not found", 403);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("id, customer_id, status")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);
  if (lpc.customer_id !== customerId) return errorResp("Not your case", 403);
  if (lpc.status !== "AWAITING_CUSTOMER_CONFIRMATION") return errorResp("Case is not awaiting confirmation");

  const { error } = await sb
    .from("lost_property_cases")
    .update({ customer_confirmed: true, status: "AWAITING_RETURN_METHOD" })
    .eq("id", case_id);

  if (error) throw error;

  await insertSystemMessage(case_id, "Customer has confirmed the item. Please select a return method.");
  return jsonResponse({ success: true });
}

// ==================== CUSTOMER: REJECT FOUND ITEM ====================
async function customerReject(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const customerId = await getCustomerId(auth.userId);
  if (!customerId) return errorResp("Customer profile not found", 403);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("id, customer_id, status")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);
  if (lpc.customer_id !== customerId) return errorResp("Not your case", 403);
  if (lpc.status !== "AWAITING_CUSTOMER_CONFIRMATION") return errorResp("Case is not awaiting confirmation");

  const { error } = await sb
    .from("lost_property_cases")
    .update({ customer_confirmed: false, status: "ESCALATED" })
    .eq("id", case_id);

  if (error) throw error;

  await insertSystemMessage(case_id, "Customer has rejected the item identification. Case escalated to support.");
  return jsonResponse({ success: true });
}

// ==================== CUSTOMER: SELECT RETURN METHOD ====================
async function customerSelectReturnMethod(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id, return_method } = await req.json();
  if (!case_id || !return_method) return errorResp("case_id and return_method are required");

  const validMethods = ["COLLECT", "BOOK_RIDE", "SHIP"];
  if (!validMethods.includes(return_method)) return errorResp(`return_method must be one of: ${validMethods.join(", ")}`);

  const customerId = await getCustomerId(auth.userId);
  if (!customerId) return errorResp("Customer profile not found", 403);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("id, customer_id, status")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);
  if (lpc.customer_id !== customerId) return errorResp("Not your case", 403);
  if (lpc.status !== "AWAITING_RETURN_METHOD") return errorResp("Case is not awaiting return method selection");

  const newStatus = return_method === "BOOK_RIDE" ? "RETURN_RIDE_REQUESTED" : "AWAITING_COLLECTION";

  const { error } = await sb
    .from("lost_property_cases")
    .update({ return_method, status: newStatus })
    .eq("id", case_id);

  if (error) throw error;

  const methodLabel = return_method === "BOOK_RIDE" ? "a return ride" : "self-collection";
  await insertSystemMessage(case_id, `Customer selected ${methodLabel} as the return method.`);

  if (return_method === "BOOK_RIDE") {
    await insertSystemMessage(case_id, "A return ride request has been sent to the original driver.");
  }

  return jsonResponse({ success: true });
}

// ==================== CREATE RETURN BOOKING (same driver) ====================
async function createReturnBooking(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const customerId = await getCustomerId(auth.userId);
  if (!customerId) return errorResp("Customer profile not found", 403);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("id, customer_id, driver_id, status, service_area_id, trip_id")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);
  if (lpc.customer_id !== customerId) return errorResp("Not your case", 403);
  if (lpc.status !== "RETURN_RIDE_REQUESTED") return errorResp("Case is not in return ride requested state");

  // Create a special trip for the return
  const { data: returnTrip, error: tripError } = await sb
    .from("trips")
    .insert({
      passenger_id: customerId,
      service_area_id: lpc.service_area_id,
      status: "pending",
      pickup_address: pickup_address || "Driver location",
      pickup_latitude: pickup_lat || 0,
      pickup_longitude: pickup_lng || 0,
      dropoff_address: dropoff_address || "Customer location",
      dropoff_latitude: dropoff_lat || 0,
      dropoff_longitude: dropoff_lng || 0,
      special_instructions: `LOST PROPERTY RETURN - Case ${case_id}`,
      booking_metadata: {
        booking_type: "LOST_PROPERTY",
        lost_property_case_id: case_id,
        target_driver_id: lpc.driver_id,
        dispatch_scope: "DIRECT_DRIVER_ONLY",
      },
    })
    .select()
    .single();

  if (tripError) throw tripError;

  await sb
    .from("lost_property_cases")
    .update({ return_trip_id: returnTrip.id })
    .eq("id", case_id);

  await insertSystemMessage(case_id, "Return ride booking created. Waiting for the driver to accept.");
  return jsonResponse({ success: true, booking_id: returnTrip.id });
}

// ==================== DRIVER: ACCEPT RETURN BOOKING ====================
async function driverAcceptReturn(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const driverId = await getDriverId(auth.userId);
  if (!driverId) return errorResp("Driver profile not found", 403);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("id, driver_id, status, return_trip_id")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);
  if (lpc.driver_id !== driverId) return errorResp("Not your case", 403);
  if (lpc.status !== "RETURN_RIDE_REQUESTED") return errorResp("No return ride to accept");

  if (lpc.return_trip_id) {
    await sb
      .from("trips")
      .update({ status: "accepted", driver_id: driverId, confirmed_driver_id: driverId })
      .eq("id", lpc.return_trip_id);
  }

  await sb
    .from("lost_property_cases")
    .update({ status: "RETURN_RIDE_BOOKED" })
    .eq("id", case_id);

  await insertSystemMessage(case_id, "Driver has accepted the return ride.");
  return jsonResponse({ success: true });
}

// ==================== DRIVER: DECLINE RETURN BOOKING ====================
async function driverDeclineReturn(req: Request) {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const driverId = await getDriverId(auth.userId);
  if (!driverId) return errorResp("Driver profile not found", 403);

  const sb = getServiceClient();
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("id, driver_id, status")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);
  if (lpc.driver_id !== driverId) return errorResp("Not your case", 403);
  if (lpc.status !== "RETURN_RIDE_REQUESTED") return errorResp("No return ride to decline");

  await sb
    .from("lost_property_cases")
    .update({ status: "ESCALATED" })
    .eq("id", case_id);

  await insertSystemMessage(case_id, "Driver declined the return ride. Case escalated to support.");
  return jsonResponse({ success: true });
}

// ==================== ADMIN: SEND SUPPORT MESSAGE ====================
async function adminSendMessage(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { case_id, message } = await req.json();
  if (!case_id || !message) return errorResp("case_id and message are required");

  const sb = getServiceClient();

  // Check if admin has joined before
  const { data: lpc } = await sb
    .from("lost_property_cases")
    .select("admin_joined_at")
    .eq("id", case_id)
    .single();

  if (!lpc) return errorResp("Case not found", 404);

  if (!lpc.admin_joined_at) {
    await sb
      .from("lost_property_cases")
      .update({ admin_joined_at: new Date().toISOString() })
      .eq("id", case_id);
    await insertSystemMessage(case_id, "Support has joined the conversation.");
  }

  const { data: msg, error } = await sb
    .from("lost_property_messages")
    .insert({
      case_id,
      sender_type: "SUPPORT",
      sender_id: admin.userId,
      message,
    })
    .select()
    .single();

  if (error) throw error;

  // Update admin last read
  await sb
    .from("lost_property_cases")
    .update({ admin_last_read_message_at: new Date().toISOString() })
    .eq("id", case_id);

  return jsonResponse({ success: true, message: msg });
}

// ==================== ADMIN: OPEN CASE ====================
async function adminOpenCase(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const sb = getServiceClient();
  const { data: lpc } = await sb.from("lost_property_cases").select("chat_expires_at").eq("id", case_id).single();
  if (!lpc) return errorResp("Case not found", 404);

  const extendedExpiry = new Date(Math.max(
    new Date(lpc.chat_expires_at).getTime(),
    Date.now() + 3 * 24 * 60 * 60 * 1000
  ));

  const { error } = await sb
    .from("lost_property_cases")
    .update({
      status: "ESCALATED",
      chat_enabled: true,
      chat_locked_at: null,
      chat_lock_reason: null,
      chat_expires_at: extendedExpiry.toISOString(),
    })
    .eq("id", case_id);

  if (error) throw error;
  await insertSystemMessage(case_id, "Case opened by support.");
  return jsonResponse({ success: true });
}

// ==================== ADMIN: REOPEN CASE ====================
async function adminReopenCase(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const sb = getServiceClient();
  const { data: lpc } = await sb.from("lost_property_cases").select("chat_expires_at").eq("id", case_id).single();
  if (!lpc) return errorResp("Case not found", 404);

  const extendedExpiry = new Date(Math.max(
    new Date(lpc.chat_expires_at).getTime(),
    Date.now() + 3 * 24 * 60 * 60 * 1000
  ));

  const { error } = await sb
    .from("lost_property_cases")
    .update({
      status: "ESCALATED",
      chat_enabled: true,
      chat_locked_at: null,
      chat_lock_reason: null,
      chat_expires_at: extendedExpiry.toISOString(),
      admin_viewed_at: null, // reset so it shows as unread
    })
    .eq("id", case_id);

  if (error) throw error;
  await insertSystemMessage(case_id, "Case reopened by support.");
  return jsonResponse({ success: true });
}

// ==================== ADMIN: CLOSE CASE ====================
async function adminCloseCase(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const sb = getServiceClient();
  const now = new Date();

  const { error } = await sb
    .from("lost_property_cases")
    .update({
      status: "CLOSED",
      chat_enabled: false,
      chat_locked_at: now.toISOString(),
      chat_lock_reason: "ADMIN_CLOSED_CASE",
      closed_at: now.toISOString(),
      photos_hidden_at: now.toISOString(),
      photos_delete_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("id", case_id);

  if (error) throw error;

  await insertSystemMessage(case_id, "Case closed by support. Chat is now locked.");
  return jsonResponse({ success: true });
}

// ==================== ADMIN: LOCK CHAT ====================
async function adminLockChat(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const sb = getServiceClient();
  const { error } = await sb
    .from("lost_property_cases")
    .update({
      chat_enabled: false,
      chat_locked_at: new Date().toISOString(),
      chat_lock_reason: "ADMIN_LOCKED_CHAT",
    })
    .eq("id", case_id);

  if (error) throw error;
  await insertSystemMessage(case_id, "Chat locked by support.");
  return jsonResponse({ success: true });
}

// ==================== ADMIN: UNLOCK CHAT ====================
async function adminUnlockChat(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const sb = getServiceClient();
  const { data: lpc } = await sb.from("lost_property_cases").select("chat_expires_at").eq("id", case_id).single();
  if (!lpc) return errorResp("Case not found", 404);

  const extendedExpiry = new Date(Math.max(
    new Date(lpc.chat_expires_at).getTime(),
    Date.now() + 3 * 24 * 60 * 60 * 1000
  ));

  const { error } = await sb
    .from("lost_property_cases")
    .update({
      chat_enabled: true,
      chat_locked_at: null,
      chat_lock_reason: null,
      chat_expires_at: extendedExpiry.toISOString(),
    })
    .eq("id", case_id);

  if (error) throw error;
  await insertSystemMessage(case_id, "Chat unlocked by support.");
  return jsonResponse({ success: true });
}

// ==================== ADMIN: MARK CASE VIEWED ====================
async function adminMarkViewed(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const { case_id } = await req.json();
  if (!case_id) return errorResp("case_id is required");

  const sb = getServiceClient();
  const now = new Date().toISOString();
  const { error } = await sb
    .from("lost_property_cases")
    .update({ admin_viewed_at: now, admin_last_read_message_at: now })
    .eq("id", case_id);

  if (error) throw error;
  return jsonResponse({ success: true });
}

// ==================== ADMIN UNREAD COUNT ====================
async function adminUnreadCount(req: Request) {
  const admin = await requireAdmin(req);
  if (admin instanceof Response) return admin;

  const sb = getServiceClient();
  const { data, error } = await sb.rpc("lost_property_admin_unread_count");
  if (error) throw error;

  return jsonResponse({ success: true, count: data });
}

// ==================== CLEANUP PHOTOS ====================
async function cleanupPhotos(_req: Request) {
  // This can be called by cron — no auth required (internal)
  const sb = getServiceClient();

  const { data: cases, error } = await sb.rpc("lost_property_get_cases_for_photo_cleanup");
  if (error) throw error;
  if (!cases || cases.length === 0) return jsonResponse({ success: true, cleaned: 0 });

  let cleaned = 0;
  for (const c of cases) {
    const allPhotos = [...(c.customer_photos || []), ...(c.found_item_photos || [])];

    // Delete from storage
    if (allPhotos.length > 0) {
      const { error: delError } = await sb.storage
        .from("lost-property-photos")
        .remove(allPhotos);
      if (delError) console.error(`[cleanup] Storage delete error for case ${c.case_id}:`, delError);
    }

    // Clear photo arrays in DB
    await sb
      .from("lost_property_cases")
      .update({ photos: [], found_item_photos: [] })
      .eq("id", c.case_id);

    cleaned++;
  }

  return jsonResponse({ success: true, cleaned });
}
