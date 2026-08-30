// supabase/functions/verify-license/index.ts
//
// Called from the contractor signup form's "Verify now" button. Checks a
// license number against NYC's own public DOB License Info dataset on
// NYC Open Data (Socrata), so verification reflects the Department of
// Buildings' actual, current license records rather than a guess.
//
// Dataset: "DOB License Info" (a.k.a. internal id "liu")
//   https://data.cityofnewyork.us/Housing-Development/liu/sqcz-wui5
// Resource endpoint used here: https://data.cityofnewyork.us/resource/sqcz-wui5.json
// Relevant columns (Socrata auto-derives these from the human-readable
// column names shown on the dataset page): license_type, license_number,
// license_status, first_name, last_name, business_name.
//
// NAME MATCHING — why this exists:
// A license NUMBER alone only proves that SOME license is real and active
// in DOB's records — it says nothing about whether the person submitting
// it actually holds that license. NYC's plumber/electrician license
// numbers are small sequential integers, so a random guess has a real
// chance of landing on someone else's genuinely active license. To guard
// against that, this function also requires the contractor's submitted
// name/business name to reasonably match the name DOB has on file for
// that license (business_name, or first_name + last_name). This isn't a
// legal identity check — it's a lightweight fuzzy string match — but it
// closes the obvious "type in a stranger's real license number" gap.
//
// IMPORTANT CAVEAT — read before relying on this for "General Contractor":
// New York City does NOT issue a "General Contractor" license through DOB.
// There is no such license type in this (or any NYC) dataset. Homeowner-
// facing general contracting isn't licensed at the city level the way
// plumbing and electrical work are — the closest analog is DCWP's Home
// Improvement Contractor (HIC) registration, a different agency and a
// different dataset. So a "GENERAL CONTRACTOR" selection here can never
// return verified:true — that's not a bug, it's an accurate reflection of
// how NYC actually regulates the trade.
//
// Also worth knowing: as of Feb 23, 2026, NYC DOB moved new applications,
// renewals, and profile changes for Electrician and Master Plumber
// licenses to a newer system called "DOB NOW: Licensing." This function
// checks the public historical/current-status dataset DOB still publishes
// from that system — the only public, queryable source available — but if
// DOB ever stops feeding this dataset from the new system, license status
// here could go stale, with no way for the function itself to detect that.
//
// Optional secret (set with `supabase secrets set NYC_OPEN_DATA_APP_TOKEN=...`):
//   NYC_OPEN_DATA_APP_TOKEN — raises your rate limit on Socrata's public
//   API. Get one free at https://data.cityofnewyork.us/profile/app_tokens.
//   Not required — the function works without it, just at the lower
//   unauthenticated request-per-second ceiling Socrata applies to anyone.
//
// SECURITY NOTE: on a successful, name-matched, ACTIVE result, this
// function writes license_verified=true directly to the contractor's row
// using the service role key — it does NOT rely on the frontend to relay
// that result back into an upsert. A migration-added trigger
// (protect_contractor_verification_fields) blocks any client-supplied
// value for license_verified/review_status from ever taking effect, so
// this function is the only path by which automated verification can
// actually mark a contractor verified.
//
// Requires "Enforce JWT Verification" / "Verify JWT with legacy secret"
// OFF — this function identifies the caller from their own session token
// in code (custom auth logic), which is what that setting's own
// recommendation is for.
//
// CORS: browsers send a preflight OPTIONS request before the real POST
// whenever a cross-origin call includes a JSON body and custom headers
// (which supabase-js's functions.invoke() always does). Every response —
// including the OPTIONS preflight response — must include CORS headers
// explicitly, or the browser blocks the request before it ever reaches
// this code.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SOCRATA_RESOURCE_URL = "https://data.cityofnewyork.us/resource/sqcz-wui5.json";
const APP_TOKEN = Deno.env.get("NYC_OPEN_DATA_APP_TOKEN"); // optional

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

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

// Maps the frontend's <select> values to a SoQL match against license_type.
function buildTypeFilter(licenseType: string): string | null {
  switch (licenseType) {
    case "MASTER PLUMBER":
      return "upper(license_type) = 'MASTER PLUMBER'";
    case "ELECTRICAL CONTRACTOR":
      return "upper(license_type) like '%ELECTRIC%'";
    default:
      return null; // GENERAL CONTRACTOR and anything unrecognized
  }
}

function normalizeName(s: string | null | undefined): string {
  return (s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function namesLooselyMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.length < 3 || b.length < 3) return a === b;
  return a.includes(b) || b.includes(a);
}

function recordMatchesSubmittedName(submittedName: string, row: Record<string, string>): boolean {
  const submitted = normalizeName(submittedName);
  if (!submitted) return false;

  const business = normalizeName(row.business_name);
  const fullName = normalizeName(`${row.first_name || ""} ${row.last_name || ""}`);
  const lastFirst = normalizeName(`${row.last_name || ""} ${row.first_name || ""}`);

  return [business, fullName, lastFirst].some(candidate => namesLooselyMatch(submitted, candidate));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) {
    return jsonResponse({ error: "Missing auth token" }, 401);
  }
  const { data: userData, error: authError } = await supabaseAdmin.auth.getUser(jwt);
  if (authError || !userData?.user) {
    return jsonResponse({ error: "Invalid or expired session" }, 401);
  }
  const callerId = userData.user.id;

  let body: { licenseNumber?: string; licenseType?: string; submittedName?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const licenseNumberRaw = (body.licenseNumber || "").trim();
  const licenseType = (body.licenseType || "").trim();
  const submittedName = (body.submittedName || "").trim();

  if (!/^[0-9]+$/.test(licenseNumberRaw)) {
    return jsonResponse({ error: "licenseNumber must be numeric" }, 400);
  }
  if (!submittedName) {
    return jsonResponse({ error: "submittedName is required" }, 400);
  }

  const typeFilter = buildTypeFilter(licenseType);
  if (!typeFilter) {
    return jsonResponse({
      verified: false,
      status: "NOT_A_DOB_LICENSE_TYPE",
      message: "NYC DOB doesn't issue licenses for this trade type, so it can't be verified this way.",
    });
  }

  const licenseNumber = String(parseInt(licenseNumberRaw, 10));
  const whereClause = `license_number = '${licenseNumber}' AND ${typeFilter}`;
  const url = `${SOCRATA_RESOURCE_URL}?$where=${encodeURIComponent(whereClause)}&$limit=20`;

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.error("NYC Open Data request failed:", resp.status, await resp.text());
      return jsonResponse({ error: "License lookup service unavailable" }, 502);
    }

    const rows: Array<Record<string, string>> = await resp.json();

    if (!rows || rows.length === 0) {
      return jsonResponse({ verified: false, status: "NOT_FOUND" });
    }

    const matchingRows = rows.filter(r => recordMatchesSubmittedName(submittedName, r));

    if (matchingRows.length === 0) {
      return jsonResponse({ verified: false, status: "NAME_MISMATCH" });
    }

    const active = matchingRows.find(r => (r.license_status || "").toUpperCase() === "ACTIVE");
    const chosen = active || matchingRows[0];

    const matchedName =
      chosen.business_name?.trim() ||
      `${chosen.first_name || ""} ${chosen.last_name || ""}`.trim() ||
      null;
    const status = (chosen.license_status || "UNKNOWN").toUpperCase();
    const isVerified = status === "ACTIVE";

    if (isVerified) {
      const { data: existingRow } = await supabaseAdmin
        .from("contractors")
        .select("id")
        .eq("id", callerId)
        .maybeSingle();

      const writePayload: Record<string, unknown> = {
        id: callerId,
        license_number: licenseNumber,
        license_type: licenseType,
        license_verified: true,
        review_status: "approved",
        reviewed_at: new Date().toISOString(),
        review_notes: `Auto-verified via NYC DOB License Info (license #${licenseNumber}, ${licenseType}).`,
      };
      if (!existingRow) {
        writePayload.business_name = submittedName;
        writePayload.trade =
          licenseType === "MASTER PLUMBER" ? "Plumbing" :
          licenseType === "ELECTRICAL CONTRACTOR" ? "Electrical" : "General";
      }

      const { error: writeError } = await supabaseAdmin
        .from("contractors")
        .upsert(writePayload, { onConflict: "id" });

      if (writeError) {
        console.error("Failed to persist license_verified=true:", writeError);
      }
    }

    return jsonResponse({ verified: true, status, matchedName });
  } catch (err) {
    console.error("verify-license error:", err);
    return jsonResponse({ error: "Internal error during license lookup" }, 500);
  }
});