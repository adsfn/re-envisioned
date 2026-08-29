// supabase/functions/create-checkout-session/index.ts
//
// Called when a homeowner clicks "Pay now" on a completed booking. Creates
// a Stripe Checkout session for the exact price the contractor set, with
// the full amount routed to the contractor's connected account.
//
// Revise is a non-profit and takes 0% — application_fee_amount is
// intentionally left unset (Stripe defaults to 0). Note this doesn't
// touch Stripe's own standard processing fee (~2.9% + 30c), which Stripe
// deducts automatically regardless of platform fee — no platform can
// waive that part, it's Stripe's own cost of moving the money.
//
// Required secrets (same STRIPE_SECRET_KEY as the other functions).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Identify the caller.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, 401);
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user) return jsonResponse({ error: "Invalid or expired session" }, 401);
    const userId = userData.user.id;

    // 2. Get the booking and confirm this user is actually the homeowner on it.
    const { booking_id } = await req.json();
    if (!booking_id) return jsonResponse({ error: "Missing booking_id" }, 400);

    const { data: booking, error: bookingError } = await supabaseAdmin
      .from("bookings")
      .select("id, homeowner_id, contractor_id, title, price_amount, status, payment_status")
      .eq("id", booking_id)
      .single();

    if (bookingError || !booking) return jsonResponse({ error: "Booking not found" }, 404);
    if (booking.homeowner_id !== userId) return jsonResponse({ error: "This booking doesn't belong to you" }, 403);
    if (booking.status !== "completed") return jsonResponse({ error: "This job hasn't been marked complete yet" }, 400);
    if (booking.payment_status === "paid") return jsonResponse({ error: "This booking has already been paid" }, 400);
    if (!booking.price_amount || booking.price_amount <= 0) return jsonResponse({ error: "This booking has no price set" }, 400);

    // 3. Get the contractor's Stripe account — they must have finished
    //    Connect onboarding before they can receive a payout.
    const { data: contractor, error: contractorError } = await supabaseAdmin
      .from("contractors")
      .select("stripe_account_id, stripe_onboarding_complete, business_name")
      .eq("id", booking.contractor_id)
      .single();

    if (contractorError || !contractor?.stripe_account_id || !contractor.stripe_onboarding_complete) {
      return jsonResponse({ error: "This contractor hasn't finished setting up payouts yet. Ask them to connect their bank in My Bookings." }, 400);
    }

    // Stripe expects amounts in cents.
    const amountInCents = Math.round(Number(booking.price_amount) * 100);

    const origin = req.headers.get("origin") || "https://re-envisioned.vercel.app";
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: booking.title || `Payment to ${contractor.business_name || "your contractor"}`,
            },
            unit_amount: amountInCents,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        // No application_fee_amount set — Revise takes 0%, the contractor
        // gets the full amount (minus Stripe's own processing fee).
        transfer_data: {
          destination: contractor.stripe_account_id,
        },
      },
      success_url: `${origin}/?page=my-bookings&payment=success`,
      cancel_url: `${origin}/?page=my-bookings&payment=cancelled`,
      metadata: {
        booking_id: booking.id,
      },
    });

    // Save the session ID so we can cross-reference it if needed later.
    await supabaseAdmin
      .from("bookings")
      .update({ stripe_checkout_session_id: checkoutSession.id })
      .eq("id", booking.id);

    return jsonResponse({ url: checkoutSession.url });
  } catch (err) {
    console.error(err);
    return jsonResponse({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}