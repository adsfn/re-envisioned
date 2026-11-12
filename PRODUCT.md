# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Revise is a two-sided marketplace, and both sides count equally. When their interests conflict, neither one automatically wins: weigh the trade-off on its merits.

- **Homeowners in New York City** who need home work done: routine jobs such as painting, cleaning or a tune-up, and emergencies such as a burst pipe, a power outage or a gas leak. They search by trade and postal code, compare pros, message them, get estimates and book.
- **Licensed local contractors in New York City**: independent trades and small businesses (plumbers, electricians, general contractors, HVAC, roofing, landscaping, cleaning, carpentry, painting, handyman). They create a profile, get their license verified, receive messages and bookings, and get paid through the app.
- **Revise admins** review pending contractor license verifications in an internal License Review view.

Coverage is the five boroughs of NYC only for now.

## Product Purpose

Revise lets homeowners hire verified local contractors directly instead of going through big home-service companies, with upfront pricing and no platform cut. It succeeds when homeowners find a trustworthy nearby pro quickly, including in an emergency, and when contractors get work and keep what they earn.

## Positioning

Revise is a **non-profit that takes 0% of payments**. Contractors receive the full amount, minus only Stripe's standard processing fee. Contractor licenses are checked against the NYC Department of Buildings' own public license records, with a check that the name matches. A for-profit marketplace can't truthfully say either of these things.

## Operating Context

- Homeowners: search by job and postal code, or use their location (with permission), within 3–15 miles. They filter by trade, price band, rating, distance and availability, and view results as a list or a map. Then they open a contractor's profile (credentials, service area and hours, portfolio, reviews), message them in-app with photos, get an itemized estimate, schedule a visit and pay through Stripe Checkout.
- Emergency flow: a dedicated Emergency Help view lists urgent issues (burst pipe, no electricity, gas leak, flooding, lockout, no heat/AC).
- Contractors: sign up with business details, services, emergency availability, bio, license number (verified instantly against NYC DOB), insurance status, a license photo for manual review, and portfolio photos. They connect a bank account through Stripe Connect and track bookings.
- Signed-in accounts have Messages, My Bookings, Edit Profile and notification preferences.

## Capabilities and Constraints

- The whole site is static HTML: a single large `index.html` holds the landing page and every app view, alongside `privacy.html`, `terms.html` and `404.html`. It is hosted on Vercel.
- The backend is Supabase. Edge functions are `verify-license`, `admin-review-license`, `create-checkout-session`, `create-connect-account` and `stripe-webhook`.
- Payments go through Stripe Checkout and Stripe Connect. No application fee is set anywhere.
- Users must be 18 or older.
- **Fee wording:** the true position is non-profit, 0%; never write copy that suggests Revise charges a fee. On 2026-11-11 the FAQ, Terms of Service §5 and §6 (in both `terms.html` and the in-app copy in `index.html`), and the Safety & Trust "Transparent pricing" card were corrected to match.
- **Claims with no backing in the code yet:** "background checked", "insured" as a guarantee, "emergency pros respond in under 45 minutes" and the per-issue emergency ETAs. Treat these as unconfirmed. Don't make them stronger or add new ones without confirmation.

## Brand Commitments

- The name is **Revise**, with an existing wordmark split as "Re" + "vise".
- Recurring promises in the current copy: transparent, itemized pricing; "no hidden fees — ever"; verified local pros; direct chat with photos. These are product promises, so the design must not undercut them.

## Evidence on Hand

- **Real:** NYC DOB license verification (`supabase/functions/verify-license/index.ts`), manual license review by admins, the 0% fee setup with Stripe, and the published Privacy Policy, Terms of Service, Safety & Trust page and Accessibility Statement.
- **Placeholders, not real:** the homepage stats ("2,400+ verified pros", "4.8 avg rating", "18k+ jobs done", "18,000+ happy homeowners"), the "Rated #1 Contractor Platform 2026" badge, every named testimonial, and the sample "Mike's Plumbing Co." profile and estimate. Future work must not present these as real and must not invent replacements. Leave room for real figures and reviews once they exist, or use honest framing until then.
- No press, awards, customer logos or case studies exist.

## Product Principles

1. **Trust is earned with things you can check.** Show how verification actually works, such as the DOB license check, rather than relying on badges and big numbers.
2. **The 0% non-profit position is the headline fact.** Keep it consistent everywhere it appears.
3. **Both sides of the marketplace are first-class.** The contractor flows (sign-up, verification, payouts) get the same care as the homeowner flows.
4. **Emergencies need speed and calm.** In an urgent flow, getting to help comes before browsing.
5. **Never fabricate proof.** Until real data exists, say less rather than invent it.

## Accessibility & Inclusion

The published Accessibility Statement commits to **WCAG 2.1 Level AA**: semantic landmarks, keyboard operation (including forms and modals), text alternatives, sufficient contrast, layouts that survive browser zoom, and visible focus indicators. The statement lists the contractor search map as a known gap that needs a stronger non-visual alternative, and notes that Stripe's checkout follows Stripe's own accessibility practices.
