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
// how NYC actually regulates the trade. Consider swapping that dropdown
// option for "Home Improvement Contractor" and wiring it to DCWP's
// "Issued Licenses" dataset (resource id w7w3-xahh) if you want real
// verification for that trade too — that's a separate dataset with its
// own license_number/license_type/license_status shape, not implemented
// here.
//
// Also worth knowing: as of Feb 23, 2026, NYC DOB moved new applications,
// renewals, and profile changes for Electrician and Master Plumber
// licenses to a newer system called "DOB NOW: Licensing." This function
// checks the public historical/current-status dataset DOB still publishes
// from that system, which is the only public, queryable source available —
// but if DOB ever stops feeding this dataset from the new system, license
// status here could go stale. There's no way to detect that from the API
// response itself, so if verification results start looking wrong across
// the board, check the dataset's "last updated" date on its NYC Open Data
// page before assuming this function is broken.
//
// Optional secret (set with `supabase secrets set NYC_OPEN_DATA_APP_TOKEN=...`):
//   NYC_OPEN_DATA_APP_TOKEN — raises your rate limit on Socrata's public
//   API. Get one free at https://data.cityofnewyork.us/profile/app_tokens.
//   Not required — the function works without it, just at the lower
//   unauthenticated request-per-second ceiling Socrata applies to anyone.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SOCRATA_RESOURCE_URL = "https://data.cityofnewyork.us/resource/sqcz-wui5.json";
const APP_TOKEN = Deno.env.get("NYC_OPEN_DATA_APP_TOKEN"); // optional

// Maps the frontend's <select> values to a SoQL match against license_type.
// Plumber has one exact DOB license_type string; electrician is matched
// loosely since DOB's exact wording for that type isn't confirmed to be a
// single fixed string in this dataset. General contractor is intentionally
// unmapped — see the caveat above.
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

// Uppercases and strips everything but letters/digits/spaces, collapsing
// whitespace — so "Gerard's Plumbing & Heating Corp." and "GERARDS
// PLUMBING HEATING CORP" compare equal.
function normalizeName(s: string | null | undefined): string {
  return (s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Lightweight fuzzy match: true if either normalized string contains the
// other. Guards against trivial false positives from very short strings
// (e.g. a single initial) matching everything.
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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  let body: { licenseNumber?: string; licenseType?: string; submittedName?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const licenseNumberRaw = (body.licenseNumber || "").trim();
  const licenseType = (body.licenseType || "").trim();
  const submittedName = (body.submittedName || "").trim();

  if (!/^[0-9]+$/.test(licenseNumberRaw)) {
    return new Response(JSON.stringify({ error: "licenseNumber must be numeric" }), { status: 400 });
  }
  if (!submittedName) {
    return new Response(JSON.stringify({ error: "submittedName is required" }), { status: 400 });
  }

  const typeFilter = buildTypeFilter(licenseType);
  if (!typeFilter) {
    // NYC DOB doesn't issue this license type (e.g. "General Contractor" —
    // see the file header comment) — there is nothing to look up, so this
    // is honestly "not found" rather than a server error.
    return new Response(
      JSON.stringify({
        verified: false,
        status: "NOT_A_DOB_LICENSE_TYPE",
        message: "NYC DOB doesn't issue licenses for this trade type, so it can't be verified this way.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // DOB's dataset stores license numbers without leading zeros in the
  // samples we've seen, so strip them before matching to avoid a false
  // "not found" if someone types e.g. "00333" instead of "333".
  const licenseNumber = String(parseInt(licenseNumberRaw, 10));

  const whereClause = `license_number = '${licenseNumber}' AND ${typeFilter}`;
  const url = `${SOCRATA_RESOURCE_URL}?$where=${encodeURIComponent(whereClause)}&$limit=20`;

  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (APP_TOKEN) headers["X-App-Token"] = APP_TOKEN;

    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      console.error("NYC Open Data request failed:", resp.status, await resp.text());
      return new Response(JSON.stringify({ error: "License lookup service unavailable" }), { status: 502 });
    }

    const rows: Array<Record<string, string>> = await resp.json();

    if (!rows || rows.length === 0) {
      return new Response(
        JSON.stringify({ verified: false, status: "NOT_FOUND" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // A license can have multiple historical rows (renewals, status
    // changes). Only consider rows whose DOB name actually matches what
    // the contractor submitted — a real, active license that belongs to
    // someone else must NOT verify.
    const matchingRows = rows.filter(r => recordMatchesSubmittedName(submittedName, r));

    if (matchingRows.length === 0) {
      // The license number is real, but not registered to this person/
      // business as far as DOB's records show.
      return new Response(
        JSON.stringify({ verified: false, status: "NAME_MISMATCH" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const active = matchingRows.find(r => (r.license_status || "").toUpperCase() === "ACTIVE");
    const chosen = active || matchingRows[0];

    const matchedName =
      chosen.business_name?.trim() ||
      `${chosen.first_name || ""} ${chosen.last_name || ""}`.trim() ||
      null;
    const status = (chosen.license_status || "UNKNOWN").toUpperCase();

    return new Response(
      JSON.stringify({ verified: true, status, matchedName }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("verify-license error:", err);
    return new Response(JSON.stringify({ error: "Internal error during license lookup" }), { status: 500 });
  }
});