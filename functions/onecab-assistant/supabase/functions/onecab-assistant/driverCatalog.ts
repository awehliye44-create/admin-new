import type { DriverReadContext } from "./driverReadContext.ts";
import type { DriverPrimaryTopic, DriverSubtopic } from "./driverDomainTypes.ts";

const CHAT =
  " I can't do that from this chat — use the control in the Driver app.";

function docHint(ctx: DriverReadContext): string {
  switch (ctx.documentState) {
    case "documents_expired":
      return " Your documents currently show as expired. Open Documents and submit a replacement where the screen allows it.";
    case "documents_rejected":
      return " A required document currently shows as rejected. Open Documents to read the reason on that document and upload a replacement where the screen allows it.";
    case "documents_pending_review":
      return " A required document is still pending review. You can go online only after required documents are approved.";
    case "documents_missing":
      return " Required documents are still missing. Open Documents and upload what the screen asks for.";
    default:
      return "";
  }
}

function onlineHint(ctx: DriverReadContext): string {
  if (ctx.online === true) return " You are online.";
  if (ctx.online === false) return " You are offline.";
  return "";
}

const PLATFORM_WALLET =
  "Open Wallet from the Driver menu. Available is what you can withdraw when a withdrawal is enabled for you. Pending is still clearing and is not available. Tips appear as their own Wallet entries. Weekly payouts and withdrawals use the payout account on your profile. I can't calculate a balance, start a withdrawal, or change the payout account.";

const COMMISSION_WALLET =
  "Open Wallet from the Driver menu. That screen is your Commission Wallet. The balance pays ONECAB commission after a completed Driver-Collected trip. It is not an earnings wallet: there is no Available or Pending fare balance, and you cannot withdraw it or receive a ONECAB weekly payout. If the balance is too low, accepting a Driver-Collected trip can be blocked. Top up only from the Commission Wallet screen when top-up is shown. I can't top up, calculate the balance, or accept a trip from this chat.";

const UNKNOWN_WALLET =
  "Open Wallet from the Driver menu. The figures on that screen follow your account type. I can't confirm withdraw, weekly payout, or Commission Wallet top-up from this chat, and I can't move money.";

function walletOverview(ctx: DriverReadContext): string {
  if (ctx.financialModel === "PLATFORM_COLLECTED") return PLATFORM_WALLET;
  if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") return COMMISSION_WALLET;
  return UNKNOWN_WALLET;
}

function payoutAnswer(ctx: DriverReadContext): string {
  if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") {
    return (
      "Commission Wallet is not paid out by ONECAB. The balance is only used for commission on Driver-Collected trips. There is no weekly payout and no withdrawal from that balance." +
      CHAT
    );
  }
  if (ctx.financialModel === "PLATFORM_COLLECTED") {
    return (
      "Weekly payouts are sent from Wallet to the payout account on your profile when ONECAB runs payouts and your available balance is eligible. Pending amounts are still clearing and are not in that payout. The Wallet screen shows your last payout. I can't promise a date or start a payout from this chat."
    );
  }
  return UNKNOWN_WALLET;
}

function withdrawAnswer(ctx: DriverReadContext): string {
  if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") {
    return "You cannot withdraw a Commission Wallet balance. It is only used to pay ONECAB commission. There is no withdrawal and no weekly payout on that screen.";
  }
  if (ctx.financialModel === "PLATFORM_COLLECTED") {
    return "Withdraw is on the Wallet screen when your service area allows it and your available balance is eligible. Pending amounts are still clearing and cannot be withdrawn. The button is Withdraw. I can't start it from this chat.";
  }
  return UNKNOWN_WALLET;
}

function pendingAnswer(ctx: DriverReadContext): string {
  if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") {
    return "Commission Wallet does not have a Pending earnings balance. Completed Driver-Collected trips use the balance for commission. Open Wallet to see that balance. I can't calculate it.";
  }
  if (ctx.financialModel === "PLATFORM_COLLECTED") {
    return "Pending on Wallet means the amount is still clearing. It is not part of Available and cannot be withdrawn yet. Available is what can be withdrawn when you are eligible. I can't calculate either figure.";
  }
  return UNKNOWN_WALLET;
}

function tipsAnswer(ctx: DriverReadContext): string {
  if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") {
    return "Tips are not a Commission Wallet top-up. Commission Wallet only records commission credits and is not an earnings payout. Open Wallet for the entries your account shows. I can't move a tip.";
  }
  if (ctx.financialModel === "PLATFORM_COLLECTED") {
    return "Card tips that ONECAB records appear as tip entries in Wallet, separate from the trip earning. I can't see or move a tip from this chat.";
  }
  return UNKNOWN_WALLET;
}

function noShowAnswer(ctx: DriverReadContext): string {
  const steps =
    "At pickup, mark Arrived, then use the in-app no-show steps only after the trip says no-show is available. Waiting is counted while you are in the pickup area for that trip with a current location fix, not merely by the clock since you tapped Arrived. ";
  if (ctx.financialModel === "PLATFORM_COLLECTED") {
    return (
      steps +
      "A no-show fee is added to Wallet only when ONECAB confirms a payable no-show. Do not assume a fee from the trip screen. Cash trips can have no fee. I can't mark no-show from this chat."
    );
  }
  if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") {
    return (
      steps +
      "Commission Wallet is not an earnings payout, so a no-show is not described as money paid into a Driver Wallet. Contact Driver Support if a no-show result looks wrong. I can't mark no-show or move money from this chat."
    );
  }
  return (
    steps +
    "Whether any fee is credited depends on your account type. I can't mark no-show or move money from this chat."
  );
}

export const DRIVER_SUBTOPICS: DriverSubtopic[] = [
  {
    id: "go_online_how",
    domain: "availability",
    label: "How to go online",
    phrases: ["going online", "go online", "how do i go online", "how to go online", "online control"],
    related: ["go_online_blocked", "location_permission", "go_offline"],
    reply: (ctx) =>
      "Use the online control on Home to receive trip offers." +
      onlineHint(ctx) +
      " Allow notifications plus precise location, including background location while you are online. On Android, set battery use to Unrestricted and allow Display over other apps when the app asks." +
      CHAT,
  },
  {
    id: "go_online_blocked",
    domain: "availability",
    label: "Why can't I go online?",
    phrases: [
      "cannot go online",
      "why cannot i go online",
      "not going online",
      "blocked from going online",
      "cant go online",
    ],
    related: ["go_online_how", "documents_status", "location_permission"],
    reply: (ctx) => {
      const specific = docHint(ctx);
      if (specific) {
        return `You stay offline until the app's check passes.${specific}${onlineHint(ctx)} I can't take you online from this chat.`;
      }
      return (
        "The Home screen states the reason when go-online is blocked. Typical checks are location permission, background location, notifications, required documents, account approval, and an assigned service area." +
        onlineHint(ctx) +
        " I only repeat a document reason when your account already shows one. I can't take you online from this chat."
      );
    },
  },
  {
    id: "go_offline",
    domain: "availability",
    label: "Going offline",
    phrases: ["go offline", "going offline", "stop receiving offers"],
    related: ["go_online_how", "offer_receive"],
    reply: () =>
      "Use the same Home control to go offline. New offers stop. A trip you already accepted stays on the trip screen." +
      CHAT,
  },
  {
    id: "location_permission",
    domain: "location",
    label: "Location permission",
    phrases: ["location permission", "precise location", "location services", "gps permission"],
    related: ["background_location", "location_not_updating", "go_online_how"],
    reply: () =>
      "ONECAB needs location to offer nearby trips and to run the trip you accepted. Allow location, turn Precise Location on, and keep it allowed while you are online. If Location Services are off, the app asks you to turn them on. I can't change phone permissions from this chat.",
  },
  {
    id: "background_location",
    domain: "location",
    label: "Background location",
    phrases: ["background location", "location in background", "phone locked location", "battery unrestricted"],
    related: ["location_permission", "location_not_updating"],
    reply: () =>
      "Allow background location while you are online, including when the phone is locked or another app is open. On Android, set ONECAB Driver battery use to Unrestricted so location and offers can continue. Some Android phones also need the in-app manufacturer steps. I can't change those settings from this chat.",
  },
  {
    id: "location_not_updating",
    domain: "location",
    label: "Location not updating",
    phrases: [
      "location isnt updating",
      "location not updating",
      "gps problem",
      "gps not working",
      "my location isnt updating",
      "location stuck",
    ],
    related: ["location_permission", "background_location", "external_navigation"],
    reply: () =>
      "Check that Location Services and Precise Location are on, then reopen the Driver app. A weak or old fix can stop offers and can pause waiting time. Move to an open area and wait for the map to follow you. I can't reset your GPS from this chat.",
  },
  {
    id: "offer_receive",
    domain: "offers",
    label: "Receiving an offer",
    phrases: ["receiving an offer", "ride offer", "trip offer", "incoming offer", "new offer"],
    related: ["offer_accept_decline", "go_online_how"],
    reply: () =>
      "While you are online, ONECAB can show a trip offer card with a countdown. Review it and accept only if you can complete the trip safely. The offer stays on screen until you accept, decline, or the countdown ends. I can't accept or decline it from this chat.",
  },
  {
    id: "offer_accept_decline",
    domain: "offers",
    label: "Accept or decline",
    phrases: ["accept a trip", "decline an offer", "declining", "accept or decline", "turn down"],
    related: ["offer_receive", "trip_arrive", "stacked_what"],
    reply: () =>
      "Accept on the offer card if you can do the trip. Decline on that card if you cannot. Declining lets ONECAB offer that same trip to someone else. For a short time you may not be offered that trip again. Declining does not change an acceptance-rate score. Missing the countdown is not the same as declining. I can't accept or decline from this chat.",
  },
  {
    id: "trip_arrive",
    domain: "trip_workflow",
    label: "Arrive at pickup",
    phrases: ["arrive at pickup", "arrived at pickup", "mark arrived", "i have arrived"],
    related: ["trip_start", "waiting_pickup", "far_from_pickup"],
    reply: () =>
      "After you accept, go to the pickup and tap Arrived when you are there. That is the step before Start Trip. If the app says you are far from the pickup, it is asking you to confirm — that message is not the waiting-time area." +
      CHAT,
  },
  {
    id: "trip_start",
    domain: "trip_workflow",
    label: "Start Trip",
    phrases: ["start trip", "starting a trip", "start the trip", "passenger is with me"],
    related: ["trip_arrive", "trip_complete", "multi_stop"],
    reply: () =>
      "Tap Start Trip when the passenger is with you, after Arrived. Starting ends pickup waiting. I can't start the trip from this chat.",
  },
  {
    id: "trip_complete",
    domain: "trip_workflow",
    label: "Complete Trip",
    phrases: [
      "complete trip",
      "complete the trip",
      "cannot complete",
      "finishing a trip",
      "rate the passenger",
      "rate passenger",
    ],
    related: ["multi_stop", "stacked_after", "trip_start"],
    reply: (ctx) => {
      const queue =
        ctx.workflow === "active_with_queue" || ctx.workflow === "queued_next"
          ? " You already have a queued next trip. Completing this one promotes it. You do not accept it again."
          : "";
      return (
        "At the final drop-off, tap Complete Trip. On a multi-stop trip, complete is only for the final destination — use Drive Next for earlier stops. After you complete, the app can ask you to rate the passenger. A queued trip is promoted when you complete, not when you finish the rating." +
        queue +
        CHAT
      );
    },
  },
  {
    id: "multi_stop",
    domain: "multi_stop",
    label: "Multi-stop trips",
    phrases: ["multi-stop", "multi stop", "drive next", "arrived at stop", "intermediate stop", "extra stop"],
    related: ["trip_arrive", "stop_waiting", "trip_complete"],
    reply: () =>
      "A multi-stop trip is Accept, Arrive at pickup, Start Trip, then for each intermediate stop tap Arrived at Stop and Drive Next. Repeat until the final destination, then Complete Trip and rate the passenger if asked. Past stops stay on the list as history. They are not steps you can edit or skip. At the final destination the app asks you to Complete Trip instead of Drive Next. I can't advance a stop from this chat.",
  },
  {
    id: "stacked_what",
    domain: "stacked_rides",
    label: "Stacked or queued rides",
    phrases: [
      "stacked",
      "queued trip",
      "queued ride",
      "next queued",
      "another trip",
      "already on one",
      "where is my next",
    ],
    related: ["stacked_after", "trip_complete", "offer_accept_decline"],
    reply: (ctx) => {
      const here =
        ctx.workflow === "active_with_queue" || ctx.workflow === "queued_next"
          ? " You have a queued trip behind the current one."
          : "";
      return (
        "A stacked offer is another trip offered while your current trip is still active. If you accept it, that next trip is queued. The current trip stays the active one. The queued trip waits. You do not search for it or accept it again." +
        here +
        " I can't accept or cancel it from this chat."
      );
    },
  },
  {
    id: "stacked_after",
    domain: "stacked_rides",
    label: "After you complete",
    phrases: ["after i complete", "after you complete", "queued becomes", "promoted"],
    related: ["stacked_what", "trip_complete"],
    reply: () =>
      "When you tap Complete Trip, ONECAB promotes the queued trip into your next active trip. Stay on the trip screen. You do not accept that queued trip a second time. Rating the passenger does not have to finish before the next trip is promoted. I can't promote it from this chat.",
  },
  {
    id: "scheduled_what",
    domain: "scheduled_rides",
    label: "What is a scheduled ride?",
    phrases: ["scheduled ride", "scheduled job", "booking tomorrow", "prebook", "pre-book", "later booking"],
    related: ["scheduled_tabs", "scheduled_activation"],
    reply: () =>
      "A scheduled ride is a trip booked for a later pickup time. It is not your current trip until you accept the activation offer near pickup time. Open Scheduled Jobs from the Driver app. I can't accept it from this chat.",
  },
  {
    id: "scheduled_tabs",
    domain: "scheduled_rides",
    label: "Requested and Confirmed",
    phrases: ["requested", "confirmed tab", "scheduled jobs", "accept a scheduled"],
    related: ["scheduled_what", "scheduled_activation", "scheduled_cancel"],
    reply: () =>
      "Scheduled Jobs has Requested and Confirmed. Requested lists jobs ONECAB has made available. Accept there to reserve the job. It then sits on Confirmed. Reserving it does not start the trip and does not send you to pickup yet. I can't accept it from this chat.",
  },
  {
    id: "scheduled_activation",
    domain: "scheduled_rides",
    label: "Activation offer",
    phrases: ["activation", "accept now to drive", "near pickup time", "scheduled offer", "becomes available", "become available"],
    related: ["scheduled_tabs", "trip_arrive", "scheduled_cancel"],
    reply: () =>
      "Near the pickup time ONECAB sends an activation offer: Accept now to drive to pickup. Accept that offer and the trip becomes your active trip on the way to pickup. Then use Arrive, Start Trip, and Complete Trip as usual. If you decline or the offer expires, ONECAB can offer the job to other drivers. I can't accept that offer from this chat.",
  },
  {
    id: "scheduled_cancel",
    domain: "scheduled_rides",
    label: "Cancel a confirmed ride",
    phrases: ["cancel a scheduled", "cancel confirmed", "cannot do the scheduled"],
    related: ["scheduled_tabs", "scheduled_activation"],
    reply: () =>
      "On a Confirmed scheduled job, cancel from that job and give a reason before it is an active trip. ONECAB can then offer it to other drivers. Once you are on the way, arrived, or the trip has started, use the normal trip cancel on the trip screen. I can't cancel it from this chat.",
  },
  {
    id: "td_what",
    domain: "towards_destination",
    label: "What it does",
    phrases: [
      "towards destination",
      "trips towards destination",
      "destination mode",
      "how do trips towards",
    ],
    related: ["td_set", "td_match", "td_off", "td_limit"],
    reply: () =>
      "Trips towards destination lets you set a place you are heading to. ONECAB then offers you ordinary trips whose drop-off is inside the destination area configured for dispatch. It does not move you up the offer list. Open it from the gold search button on idle Home. The banner says Matching trips towards… while it is on. I can't turn it on from this chat.",
  },
  {
    id: "td_set",
    domain: "towards_destination",
    label: "Set a destination",
    phrases: ["set my destination", "set destination", "how do i set", "enter a destination", "where are you going"],
    related: ["td_search", "td_what", "td_off"],
    reply: () =>
      "On idle Home, tap the gold search button, then Where are you going? Pick a search result or a saved place. ONECAB saves that place and shows Matching trips towards… on Home. Close the banner to turn it off. I can't set the destination from this chat.",
  },
  {
    id: "td_search",
    domain: "towards_destination",
    label: "Address or postcode",
    phrases: ["postcode", "post code", "enter a postcode", "search by address", "street address", "landmark"],
    related: ["td_set", "td_match"],
    reply: () =>
      "The destination search accepts an address, street, landmark, business name, or a UK postcode. Choose one of the results. You do not need a separate postcode field. I can't search or save a place from this chat.",
  },
  {
    id: "td_match",
    domain: "towards_destination",
    label: "How matching works",
    phrases: ["how matching works", "destination radius", "drop-off", "dropoff", "matching trips towards"],
    related: ["td_none", "td_what", "offer_receive"],
    reply: () =>
      "While Trips towards destination is on, a trip is offered only if its drop-off is within the destination radius from your dispatch settings. A trip that qualifies is a normal ride offer with the usual countdown. Trips outside that radius are not offered to you. This is a filter, not a boost. Other drivers can still be offered the same trip. I can't change the radius from this chat.",
  },
  {
    id: "td_none",
    domain: "towards_destination",
    label: "Why no matching trips",
    phrases: [
      "not getting trips towards",
      "no trips towards",
      "why am i not getting",
      "no matching",
      "destination not working",
    ],
    related: ["td_match", "td_off", "go_online_how"],
    reply: () =>
      "You only see trips whose drop-off is inside the configured destination radius, and only while you are online and eligible for offers. If drop-offs are outside that area, nothing is offered for this filter. A normal offer still appears when a trip's drop-off is inside the area. Check the banner is showing the place you chose, and that you are online. I can't refresh matching from this chat.",
  },
  {
    id: "td_off",
    domain: "towards_destination",
    label: "Turn it off",
    phrases: ["turn it off", "turn off destination", "stop matching", "disable destination", "clear destination"],
    related: ["td_what", "td_set"],
    reply: () =>
      "On Home, close the Matching trips towards… banner. That stops the destination filter. New offers are no longer limited to that drop-off area. I can't turn it off from this chat.",
  },
  {
    id: "td_limit",
    domain: "towards_destination",
    label: "Usage limit",
    phrases: [
      "usage limit",
      "how many times can i use",
      "how many times",
      "used destination",
      "why cannot i use towards",
      "cannot use towards",
    ],
    related: ["td_set", "td_what"],
    reply: () =>
      "There is a usage limit for Trips towards destination. The app will tell you if the limit has been reached. I can't see the remaining uses or change the limit from this chat.",
  },
  {
    id: "waiting_pickup",
    domain: "waiting",
    label: "Pickup waiting",
    phrases: ["waiting at pickup", "free waiting", "pickup waiting", "waiting time"],
    related: ["waiting_not_increasing", "waiting_noshow", "trip_arrive"],
    reply: () =>
      "After you tap Arrived, the trip can start a waiting timer. A free waiting period can apply first. How long it lasts is set on that trip's service settings, so it is not one length for every driver. Paid waiting, if that trip has it, starts after the free period. I can't start or change the timer from this chat.",
  },
  {
    id: "waiting_not_increasing",
    domain: "waiting",
    label: "Waiting not increasing",
    phrases: [
      "waiting money",
      "waiting charge",
      "waiting not increasing",
      "waiting increasing",
      "isnt waiting",
      "paid waiting",
    ],
    related: ["waiting_pickup", "far_from_pickup", "location_not_updating"],
    reply: () =>
      "Waiting charge does not have to rise the moment you tap Arrived. It depends on that trip's settings. It stays still when any of these apply: you are outside the pickup area that counts for waiting; the location fix is not current enough; free waiting is still running; paid waiting is not enabled on that trip; the current paid interval has not finished; or the configured cap is already reached. The far-from-pickup confirmation is a separate check and is not that waiting area. I can't tell which of these applies unless the trip screen already says so, and I can't add a charge from this chat.",
  },
  {
    id: "far_from_pickup",
    domain: "waiting",
    label: "Far from pickup",
    phrases: ["far from the pickup", "too far from pickup", "far from pickup"],
    related: ["trip_arrive", "waiting_not_increasing"],
    reply: () =>
      "If the app says you are far from the pickup, it is asking you to confirm Arrived. That confirmation is not the area used for waiting time or no-show. Waiting time uses the pickup area configured for the trip, and only while your location fix is current. I can't override that check from this chat.",
  },
  {
    id: "stop_waiting",
    domain: "waiting",
    label: "Waiting at a stop",
    phrases: ["waiting at a stop", "waiting at stop", "stop waiting"],
    related: ["multi_stop", "waiting_pickup"],
    reply: () =>
      "At an intermediate stop, tap Arrived at Stop. Stop waiting follows that trip's stop settings, which can differ from pickup waiting. Tap Drive Next when you leave the stop. That finishes stop waiting. I can't mark the stop from this chat.",
  },
  {
    id: "waiting_noshow",
    domain: "cancellations",
    label: "Passenger no-show",
    phrases: [
      "no-show",
      "no show",
      "passenger hasnt",
      "passenger has not",
      "hasnt come out",
      "has not arrived",
      "passenger late",
    ],
    related: ["waiting_pickup", "cancel_passenger", "trip_arrive"],
    reply: noShowAnswer,
  },
  {
    id: "cancel_passenger",
    domain: "cancellations",
    label: "Passenger cancellation",
    phrases: ["passenger cancelled", "rider cancelled", "customer cancelled"],
    related: ["waiting_noshow", "cancel_driver"],
    reply: () =>
      "If the passenger cancels, the trip leaves your screen. You do not complete it. Any fee message on the trip is from ONECAB, not from this chat. I can't cancel a trip.",
  },
  {
    id: "cancel_driver",
    domain: "cancellations",
    label: "Driver cancellation",
    phrases: ["cancel the trip", "i need to cancel", "driver cancel", "cannot do this trip"],
    related: ["cancel_passenger", "trip_complete"],
    reply: () =>
      "Before the trip has started, cancel from the trip screen and choose a reason. ONECAB can look for another driver. After you have started, cancel is also on the trip screen. A queued trip has its own cancel if you cannot do that next job. I can't cancel from this chat.",
  },
  {
    id: "external_navigation",
    domain: "navigation",
    label: "External navigation",
    phrases: [
      "google maps",
      "apple maps",
      "waze",
      "navigation isnt",
      "navigation not working",
      "open navigation",
      "external navigation",
    ],
    related: ["nav_legs", "location_not_updating"],
    reply: () =>
      "From the trip, open navigation and choose Google Maps, Waze, or Apple Maps on iPhone. The chosen app must be installed. When you switch back to ONECAB Driver, the trip screen is still there — use Arrived, Drive Next, or Complete Trip in ONECAB. I can't open maps or change the navigation app from this chat.",
  },
  {
    id: "nav_legs",
    domain: "navigation",
    label: "Pickup, stop, and drop-off",
    phrases: ["navigate to pickup", "navigate to stop", "drop-off navigation", "drop off navigation"],
    related: ["external_navigation", "multi_stop", "trip_arrive"],
    reply: () =>
      "Navigation follows the current leg: to pickup, then to each stop, then to the drop-off. Change of leg can open the navigation app again if auto-launch is on. Waiting at pickup or a stop does not start a new driving leg. I can't change the route from this chat.",
  },
  {
    id: "wallet_overview",
    domain: "wallet",
    label: "Wallet",
    phrases: ["my wallet", "wallet and earnings", "trip earnings", "available balance"],
    related: ["wallet_pending", "wallet_withdraw", "wallet_payout", "wallet_tips"],
    reply: walletOverview,
  },
  {
    id: "wallet_pending",
    domain: "earnings",
    label: "Pending earnings",
    phrases: ["still pending", "pending balance", "funds clearing", "earnings pending", "earnings are pending"],
    related: ["wallet_overview", "wallet_withdraw"],
    reply: pendingAnswer,
  },
  {
    id: "wallet_withdraw",
    domain: "payouts",
    label: "Withdraw",
    phrases: ["withdraw", "withdrawal", "cash out", "cashout"],
    related: ["wallet_pending", "wallet_payout", "payout_account"],
    reply: withdrawAnswer,
  },
  {
    id: "wallet_payout",
    domain: "payouts",
    label: "Weekly payout",
    phrases: ["weekly payout", "payout", "where is my payout", "paid weekly"],
    related: ["wallet_withdraw", "payout_account", "wallet_pending"],
    reply: payoutAnswer,
  },
  {
    id: "wallet_tips",
    domain: "tips",
    label: "Tips",
    phrases: ["tips", "a tip", "passenger tip"],
    related: ["wallet_overview"],
    reply: tipsAnswer,
  },
  {
    id: "wallet_commission",
    domain: "commission_wallet",
    label: "Commission Wallet",
    phrases: [
      "commission wallet",
      "commission balance",
      "commission deducted",
      "commission is deducted",
      "top up",
      "topup",
      "cannot accept",
      "low balance",
    ],
    related: ["wallet_overview"],
    reply: (ctx) => {
      if (ctx.financialModel === "PLATFORM_COLLECTED") {
        return "Your account uses Wallet for trip earnings. Commission is already taken off the card-trip amounts shown there. You do not top up a Commission Wallet, and this chat can't move money.";
      }
      if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") return COMMISSION_WALLET;
      return UNKNOWN_WALLET;
    },
  },
  {
    id: "payout_account",
    domain: "payouts",
    label: "Payout account",
    phrases: ["payout account", "bank account", "where do payouts go"],
    related: ["wallet_payout", "profile_details"],
    reply: (ctx) => {
      if (ctx.financialModel === "DRIVER_COLLECTED_COMMISSION_WALLET") {
        return "A Commission Wallet balance is not sent to a payout account. There is no ONECAB weekly payout on this account.";
      }
      if (ctx.financialModel === "PLATFORM_COLLECTED") {
        return "Add a payout account from your profile or Wallet when the app asks. Withdrawals and weekly payouts use that account. I can't change it from this chat.";
      }
      return UNKNOWN_WALLET;
    },
  },
  {
    id: "documents_required",
    domain: "documents",
    label: "Required documents",
    phrases: ["required documents", "what documents", "driver documents", "vehicle documents"],
    related: ["documents_upload", "documents_status"],
    reply: () =>
      "Open Documents from the Driver menu. The list is the documents your service area requires, for you and for the vehicle. Required documents must be approved and in date before you can go online. I can't upload or approve them.",
  },
  {
    id: "documents_upload",
    domain: "documents",
    label: "Upload or replace",
    phrases: ["upload a document", "replace a document", "update a document", "update documents"],
    related: ["documents_status", "documents_required"],
    reply: () =>
      "On Documents, open the item and take or choose a clear photo. A replacement appears only when that document says you can submit one. I can't upload it from this chat.",
  },
  {
    id: "documents_status",
    domain: "documents",
    label: "Pending, rejected, or expired",
    phrases: [
      "document rejected",
      "document was rejected",
      "rejected document",
      "expired document",
      "document expired",
      "pending review",
      "document pending",
      "expiring",
    ],
    related: ["documents_upload", "go_online_blocked"],
    reply: (ctx) =>
      "Documents can show Required, Uploading, Pending review, Approved, Rejected, Expiring soon, Expired, or Upload failed. You cannot go online while a required document is missing, pending, rejected, or expired." +
      docHint(ctx) +
      " There is no fixed approval time. If a document is rejected, the reason is on that document when ONECAB has provided one. I can't approve it from this chat.",
  },
  {
    id: "profile_photo",
    domain: "profile",
    label: "Profile photo",
    phrases: ["profile photo", "change my photo", "driver photo", "change my picture"],
    related: ["profile_details", "documents_upload"],
    reply: () =>
      "The profile photo is updated from your profile or from Documents when a profile photo is one of your required documents. Use the photo control on that screen. I can't change it from this chat.",
  },
  {
    id: "profile_details",
    domain: "profile",
    label: "Profile and contact",
    phrases: ["profile information", "contact details", "change my phone", "my profile"],
    related: ["profile_photo", "account_access"],
    reply: () =>
      "Open Profile from the Driver menu for your name and contact details. Change only the fields the screen allows. I can't edit your profile from this chat.",
  },
  {
    id: "vehicle_info",
    domain: "vehicle",
    label: "Vehicle",
    phrases: ["vehicle information", "my vehicle", "change vehicle", "car details"],
    related: ["documents_required", "profile_details"],
    reply: () =>
      "Vehicle details and vehicle documents are on your profile and Documents screens. You can go online only with an eligible vehicle. I can't change the vehicle from this chat.",
  },
  {
    id: "account_access",
    domain: "account",
    label: "Sign-in and account",
    phrases: ["sign in", "signed out", "another device", "account access", "account approval", "account suspended"],
    related: ["go_online_blocked", "support_contact"],
    reply: () =>
      "One Driver account is active on one device. Signing in on a new phone signs the previous phone out. If the account is pending approval, suspended, or not active, the app tells you and you stay offline. Never share your sign-in code. I can't change account status from this chat.",
  },
  {
    id: "safety_emergency",
    domain: "safety",
    label: "Emergency",
    phrases: ["accident", "crash", "vehicle problem", "broken down", "passenger safety", "safety concern", "feel unsafe"],
    related: ["support_contact"],
    reply: () =>
      "If you or anyone else is in immediate danger, call 999. ONECAB support is not a replacement for the emergency services. When it is safe, use Contact Driver Support on this screen and describe the accident, vehicle problem, or passenger issue. I can't contact the police for you.",
  },
  {
    id: "lost_property",
    domain: "support",
    label: "Lost property",
    phrases: ["lost property", "left something", "passenger left", "found an item"],
    related: ["support_contact"],
    reply: () =>
      "Open Lost Property from the Driver menu to see a report or to record an item you found. After the trip, exact pickup and drop-off addresses are hidden. Use Contact Driver Support if you need help with a report. I can't file it from this chat.",
  },
  {
    id: "support_contact",
    domain: "support",
    label: "Contact Driver Support",
    phrases: [
      "contact driver support",
      "contact support",
      "talk to a human",
      "speak to someone",
      "email support",
    ],
    related: ["safety_emergency", "lost_property"],
    reply: () =>
      "Use Contact Driver Support on this screen. The app opens the support email or chat configured for your build. I can't invent a phone number or email address.",
  },
];

export const DRIVER_PRIMARY_TOPICS: DriverPrimaryTopic[] = [
  {
    id: "going_online",
    intro: "Going online. Choose what you need.",
    subtopicIds: ["go_online_how", "go_online_blocked", "location_permission", "background_location", "go_offline"],
  },
  {
    id: "trips_offers",
    intro: "Trips and offers. Choose a step.",
    subtopicIds: [
      "offer_receive",
      "offer_accept_decline",
      "trip_arrive",
      "trip_start",
      "multi_stop",
      "stacked_what",
      "waiting_pickup",
      "waiting_noshow",
      "trip_complete",
    ],
  },
  {
    id: "scheduled_rides",
    intro: "Scheduled rides. Choose a topic.",
    subtopicIds: ["scheduled_what", "scheduled_tabs", "scheduled_activation", "scheduled_cancel"],
  },
  {
    id: "towards_destination",
    intro: "Trips towards destination. Choose a topic.",
    subtopicIds: ["td_what", "td_set", "td_search", "td_match", "td_none", "td_off", "td_limit"],
  },
  {
    id: "wallet_earnings",
    intro: "Wallet and earnings. Choose a topic.",
    subtopicIds: [
      "wallet_overview",
      "wallet_pending",
      "wallet_withdraw",
      "wallet_payout",
      "wallet_tips",
      "wallet_commission",
      "payout_account",
    ],
  },
  {
    id: "documents",
    intro: "Documents. Choose a topic.",
    subtopicIds: ["documents_required", "documents_upload", "documents_status", "profile_photo"],
  },
  {
    id: "navigation_location",
    intro: "Navigation and location. Choose a topic.",
    subtopicIds: [
      "location_permission",
      "background_location",
      "external_navigation",
      "nav_legs",
      "location_not_updating",
    ],
  },
  {
    id: "more_help",
    intro: "More help. Choose a topic.",
    subtopicIds: [
      "profile_details",
      "vehicle_info",
      "account_access",
      "safety_emergency",
      "lost_property",
      "support_contact",
    ],
  },
];

const BY_ID = new Map(DRIVER_SUBTOPICS.map((topic) => [topic.id, topic]));

export function driverSubtopic(id: string): DriverSubtopic | undefined {
  return BY_ID.get(id);
}

export function driverFollowUps(ids: string[]): { id: string; label: string }[] {
  const seen = new Set<string>();
  const chips: { id: string; label: string }[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const topic = BY_ID.get(id);
    if (!topic) continue;
    seen.add(id);
    chips.push({ id: topic.id, label: topic.label });
  }
  return chips;
}
