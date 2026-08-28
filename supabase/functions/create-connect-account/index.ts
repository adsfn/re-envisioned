// supabase/functions/create-connect-account/index.ts
//
// Called from the contractor dashboard when they click "Connect your bank."
// Creates a Stripe Express connected account for the logged-in contractor
// (or reuses one if they already have it), then returns a one-time
// onboarding link that sends them to a Stripe-hosted page to enter their
// bank details and identity info.
//
// Required secrets (set with `supabase secrets set NAME=value`):
//   STRIPE_SECRET_KEY   — your test secret key (sk_test_...) for now
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Supabase runtime — you don't set those yourself.

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

// Standard CORS headers so the browser (running on your Vercel domain)
// is allowed to call this function directly.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Preflight request — browsers send this automatically before the real one.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Identify who's calling. The frontend sends the user's Supabase
    //    session token in the Authorization header; we verify it here so
    //    a random visitor can't create Stripe accounts on someone else's behalf.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing Authorization header" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !userData?.user) {
      return jsonResponse({ error: "Invalid or expired session" }, 401);
    }
    const userId = userData.user.id;

    // 2. Look up this contractor's row. They must have already submitted
    //    the contractor signup form (business_name etc.) before this step.
    const { data: contractor, error: contractorError } = await supabaseAdmin
      .from("contractors")
      .select("id, stripe_account_id, business_name")
      .eq("id", userId)
      .single();

    if (contractorError || !contractor) {
      return jsonResponse({ error: "No contractor profile found for this user. Complete contractor signup first." }, 404);
    }

    // 3. Reuse their existing Stripe account if they already started/finished
    //    onboarding before; otherwise create a fresh Express account.
    let accountId = contractor.stripe_account_id;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: userData.user.email ?? undefined,
        business_type: "individual",
        business_profile: {
          name: contractor.business_name || undefined,
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = account.id;

      // Save it immediately so we never orphan a Stripe account with no
      // matching row — even if something fails later in this request.
      const { error: saveError } = await supabaseAdmin
        .from("contractors")
        .update({ stripe_account_id: accountId })
        .eq("id", userId);
      if (saveError) {
        return jsonResponse({ error: `Created Stripe account but failed to save it: ${saveError.message}` }, 500);
      }
    }

    // 4. Generate a one-time onboarding link. These expire quickly (a few
    //    minutes) and are single-use, so we create a fresh one on every call
    //    rather than trying to reuse/cache it.
    const origin = req.headers.get("origin") || "https://re-envisioned.vercel.app";
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/?page=my-bookings&stripe=refresh`,
      return_url: `${origin}/?page=my-bookings&stripe=return`,
      type: "account_onboarding",
    });

    return jsonResponse({ url: accountLink.url });
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
