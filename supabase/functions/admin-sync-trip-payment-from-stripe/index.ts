/** Stripe retired — endpoint permanently unavailable. */
Deno.serve(() =>
  new Response(JSON.stringify({ error: "STRIPE_RETIRED", message: "Stripe is no longer a ONECAB payment provider" }), {
    status: 410,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  })
);
