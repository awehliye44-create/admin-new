/**
 * Stripe webhook — permanently retired.
 * Revolut is the only card payment provider. Historical Stripe events are not processed.
 */
Deno.serve(() =>
  new Response(JSON.stringify({
    error: "STRIPE_RETIRED",
    message: "Stripe webhook disabled; Revolut is the only payment provider",
  }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  })
);
