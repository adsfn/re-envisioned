// supabase/functions/stripe-webhook/index.ts
//
// Stripe calls this function directly whenever something happens on your
// account. Handles two things:
//   - `account.updated` — fires when a contractor's Connect onboarding
//     status changes; flips stripe_onboarding_complete once they can
//     accept charges, so the "Connect your bank" banner disappears.
//   - `checkout.session.completed` — fires when a homeowner successfully
//     pays for a completed job; marks that booking as paid.
//
// Required secrets (set with `supabase secrets set NAME=value`):
//   STRIPE_SECRET_KEY            — same one used by the other functions
//   STRIPE_WEBHOOK_SECRET        — signing secret for the "Connected
//                                  accounts" destination (account.updated)
//   STRIPE_WEBHOOK_SECRET_PLATFORM — signing secret for the "Your account"
//                                  destination (checkout.session.completed).
//                                  These are two SEPARATE destinations in
//                                  Stripe pointing at this same function URL,
//                                  each with its own secret — Stripe scopes
//                                  connected-account events and platform
//                                  events into different destinations, so
//                                  one endpoint here needs to accept both.
//
// IMPORTANT: this endpoint must have "Enforce JWT Verification" turned OFF
// in the Supabase dashboard. Stripe has no Supabase session token to send —
// it authenticates itself with a signature instead, which we verify below.
// You'll also need to add the checkout.session.completed event to this
// same webhook endpoint in Stripe (Developers > Webhooks > your endpoint >
// add event), the same way account.updated was added.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20",
});
// Both destinations point at this same function, each with its own secret.
// Passing an array lets Stripe's SDK accept a signature matching either one.
const webhookSecrets = [
  Deno.env.get("STRIPE_WEBHOOK_SECRET"),
  Deno.env.get("STRIPE_WEBHOOK_SECRET_PLATFORM"),
].filter((s): s is string => !!s);

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Stripe signs the raw request body — we must verify against the exact
  // unparsed text, not a re-serialized JSON object, or the signature check
  // will always fail.
  const signature = req.headers.get("stripe-signature");
  const rawBody = await req.text();

  if (!signature) {
    return new Response("Missing stripe-signature header", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecrets);
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return new Response(`Webhook signature verification failed`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        // charges_enabled means Stripe has verified enough info for this
        // account to actually receive money — that's our "done" signal.
        const isComplete = !!account.charges_enabled;

        const { error } = await supabaseAdmin
          .from("contractors")
          .update({ stripe_onboarding_complete: isComplete })
          .eq("stripe_account_id", account.id);

        if (error) {
          console.error("Failed to update contractor onboarding status:", error);
          // Still return 200 below — Stripe will retry on non-2xx, and this
          // is a DB-side issue that retrying won't necessarily fix. Logged
          // for visibility instead.
        }
        break;
      }
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const bookingId = session.metadata?.booking_id;
        if (!bookingId) {
          console.error("checkout.session.completed had no booking_id in metadata");
          break;
        }

        const { error } = await supabaseAdmin
          .from("bookings")
          .update({
            payment_status: "paid",
            stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
          })
          .eq("id", bookingId);

        if (error) {
          console.error("Failed to mark booking as paid:", error);
        }
        break;
      }
      default:
        // Other event types aren't handled yet — safe to ignore.
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: "Internal error handling webhook" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});