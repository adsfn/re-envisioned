// supabase/functions/admin-review-license/index.ts
//
// Powers the admin license-review page. Two actions, both requiring the
// caller to be an admin (profiles.is_admin = true):
//
//   { action: "list" }
//     Returns contractors with review_status = 'pending_review', each
//     with a short-lived signed URL for their uploaded license photo
//     (the license-documents bucket is private — this is the only way
//     to view a photo, since there's no public/authenticated read policy
//     on that bucket at all).
//
//   { action: "decide", contractorId, approve: boolean, notes?: string }
//     Approves or rejects that contractor's license. This is the ONLY
//     path (besides the automated verify-license function) that can move
//     review_status to 'approved'/'rejected' or set license_verified —
//     the protect_contractor_verification_fields trigger blocks every
//     other caller from touching those columns directly.
//
// Requires "Enforce JWT Verification" / "Verify JWT with legacy secret"
// OFF — this function does its own caller-identity check in code (see
// requireAdmin below), which is the recommended pattern per Supabase's
// own guidance for functions with custom auth logic.
//
// CORS: browsers send a preflight OPTIONS request before the real POST
// whenever a cross-origin call includes a JSON body and custom headers
// (which supabase-js's functions.invoke() always does). Edge Functions do
// NOT get CORS headers automatically — every response, including the
// preflight response, must include them explicitly, or the browser blocks
// the request before it ever reaches this code (which shows up as a
// generic "Failed to send a request" error on the client, with nothing
// in this function's own logs, since the request never actually arrives).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SIGNED_URL_EXPIRY_SECONDS = 300; // 5 minutes — plenty for one review pass

// Applied to every response this function returns, success or error.
// "*" is fine here since this endpoint requires a valid Supabase session
// token regardless of origin — the real access control is the JWT +
// is_admin check inside requireAdmin(), not the browser's origin check.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function requireAdmin(req: Request): Promise<{ id: string } | Response> {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return jsonResponse({ error: "Missing auth token" }, 401);
  }
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(jwt);
  if (authError || !userData?.user) {
    return jsonResponse({ error: "Invalid or expired session" }, 401);
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile?.is_admin) {
    return jsonResponse({ error: "Forbidden — admin access required" }, 403);
  }

  return { id: userData.user.id };
}

Deno.serve(async (req) => {
  // Browsers send this automatically before the real request; it must
  // succeed with the right headers or the actual POST never gets sent.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const adminCheck = await requireAdmin(req);
  if (adminCheck instanceof Response) return adminCheck;

  let body: { action?: string; contractorId?: string; approve?: boolean; notes?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (body.action === "list") {
    const { data: rows, error } = await supabaseAdmin
      .from("contractors")
      .select(`
        id, business_name, trade, license_number, license_type,
        license_photo_path, review_status,
        profiles ( first_name, last_name, email )
      `)
      .eq("review_status", "pending_review")
      .order("id", { ascending: true });

    if (error) {
      console.error("Failed to list pending reviews:", error);
      return jsonResponse({ error: "Failed to load pending reviews" }, 500);
    }

    const withUrls = await Promise.all(
      (rows || []).map(async (row) => {
        let photoUrl: string | null = null;
        if (row.license_photo_path) {
          const { data: signed, error: signError } = await supabaseAdmin.storage
            .from("license-documents")
            .createSignedUrl(row.license_photo_path, SIGNED_URL_EXPIRY_SECONDS);
          if (signError) {
            console.error(`Failed to sign URL for ${row.license_photo_path}:`, signError);
          } else {
            photoUrl = signed?.signedUrl || null;
          }
        }
        return { ...row, photoUrl };
      })
    );

    return jsonResponse({ pending: withUrls });
  }

  if (body.action === "decide") {
    if (!body.contractorId || typeof body.approve !== "boolean") {
      return jsonResponse({ error: "contractorId and approve are required" }, 400);
    }

    const { error } = await supabaseAdmin
      .from("contractors")
      .update({
        license_verified: body.approve,
        review_status: body.approve ? "approved" : "rejected",
        reviewed_at: new Date().toISOString(),
        review_notes: body.notes || null,
      })
      .eq("id", body.contractorId);

    if (error) {
      console.error("Failed to record review decision:", error);
      return jsonResponse({ error: "Failed to save decision" }, 500);
    }

    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: "Unknown action" }, 400);
});