Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "STRIPE_RETIRED",
      message: "Stripe is no longer a ONECAB payment provider. Revolut is the live payment SSOT.",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  ),
);
