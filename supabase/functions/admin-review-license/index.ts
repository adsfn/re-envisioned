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
// Requires "Enforce JWT Verification" ON — this identifies the caller
// from their own session token and checks their admin flag before doing
// anything.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SIGNED_URL_EXPIRY_SECONDS = 300; // 5 minutes — plenty for one review pass

async function requireAdmin(req: Request): Promise<{ id: string } | Response> {
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return new Response(JSON.stringify({ error: "Missing auth token" }), { status: 401 });
  }
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(jwt);
  if (authError || !userData?.user) {
    return new Response(JSON.stringify({ error: "Invalid or expired session" }), { status: 401 });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("is_admin")
    .eq("id", userData.user.id)
    .single();

  if (profileError || !profile?.is_admin) {
    return new Response(JSON.stringify({ error: "Forbidden — admin access required" }), { status: 403 });
  }

  return { id: userData.user.id };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const adminCheck = await requireAdmin(req);
  if (adminCheck instanceof Response) return adminCheck;

  let body: { action?: string; contractorId?: string; approve?: boolean; notes?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
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
      return new Response(JSON.stringify({ error: "Failed to load pending reviews" }), { status: 500 });
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

    return new Response(JSON.stringify({ pending: withUrls }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (body.action === "decide") {
    if (!body.contractorId || typeof body.approve !== "boolean") {
      return new Response(JSON.stringify({ error: "contractorId and approve are required" }), { status: 400 });
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
      return new Response(JSON.stringify({ error: "Failed to save decision" }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400 });
});