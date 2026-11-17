-- ============================================================
-- Security hardening (2026-11-16)
--
-- Closes holes confirmed by testing as an ordinary signed-in user:
--   1. Anyone could make themselves an admin (profiles.is_admin).
--   2. Anyone signed in could read every user's email and phone.
--   3. avatar_url / portfolio_urls accepted any string (stored XSS).
--   4. Either side of a booking could rewrite any column: cut the
--      price after the job, reassign the contractor, self-complete.
--   5. Fake reviews: self-"completed" booking + review aimed at any
--      contractor_id, not the one on the booking.
--   6. Contractors could set their own Verified badge (is_verified),
--      Stripe payout fields, and starting rating/review_count.
--   7. Contractor signup was broken: the verification trigger wrote a
--      license_verified column that didn't exist.
--   8. Storage buckets accepted any file type and size.
--
-- Service-role code (the Edge Functions) is trusted throughout and
-- bypasses these checks, as before.
-- ============================================================

-- ------------------------------------------------------------
-- 1 + 3. PROFILES: no self-granted admin, safe avatar URLs
-- ------------------------------------------------------------
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.is_admin := false;
  else
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;
revoke execute on function public.protect_profile_fields() from public, anon, authenticated;

drop trigger if exists trg_protect_profile_fields on public.profiles;
create trigger trg_protect_profile_fields
  before insert or update on public.profiles
  for each row execute function public.protect_profile_fields();

-- True when every URL points into the given public bucket of this project
-- and contains none of the characters that can break out of HTML/CSS.
create or replace function public.urls_in_bucket(urls text[], bucket text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select coalesce(bool_and(
    u like 'https://slurbxjdhlpltxqlnevy.supabase.co/storage/v1/object/public/' || bucket || '/%'
    and u !~ '[''"()<>\s\\]'
  ), true)
  from unnest(urls) as u
$$;

alter table public.profiles
  drop constraint if exists profiles_avatar_url_safe,
  add constraint profiles_avatar_url_safe
    check (avatar_url is null or public.urls_in_bucket(array[avatar_url], 'avatars'));

-- ------------------------------------------------------------
-- 2. PROFILES: email and phone are private
-- Other users only ever need name/avatar/role (contractor cards,
-- booking counterparts). Your own full row comes from get_my_profile().
-- The admin review page reads emails with the service role, unaffected.
-- ------------------------------------------------------------
revoke select on public.profiles from anon, authenticated;
grant select (id, first_name, last_name, role, avatar_url, created_at, is_admin)
  on public.profiles to anon, authenticated;

create or replace function public.get_my_profile()
returns setof public.profiles
language sql
stable
security definer
set search_path = public
as $$
  select * from public.profiles where id = auth.uid()
$$;
revoke execute on function public.get_my_profile() from public, anon;
grant execute on function public.get_my_profile() to authenticated;

-- ------------------------------------------------------------
-- 6 + 7. CONTRACTORS: real license_verified column, protected badge,
-- protected payout and rating fields
-- ------------------------------------------------------------
alter table public.contractors
  add column if not exists license_verified boolean not null default false;

alter table public.contractors
  drop constraint if exists contractors_portfolio_urls_safe,
  add constraint contractors_portfolio_urls_safe
    check (portfolio_urls is null or public.urls_in_bucket(portfolio_urls, 'portfolios'));

create or replace function public.protect_contractor_verification_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Service-role requests (verify-license, admin-review-license, the
  -- Stripe functions) are trusted. The public Verified badge always
  -- mirrors license_verified.
  if auth.role() = 'service_role' then
    new.is_verified := coalesce(new.license_verified, false);
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.license_verified := false;
    new.reviewed_at := null;
    new.review_notes := null;
    new.stripe_account_id := null;
    new.stripe_onboarding_complete := false;
    new.rating := 0;
    new.review_count := 0;
    -- Uploading a photo at signup is a request for review, not a grant of it.
    if new.license_photo_path is not null then
      new.review_status := 'pending_review';
    else
      new.review_status := 'unverified';
    end if;
  else
    -- Verification and payout fields never move except via service-role code.
    new.license_verified := old.license_verified;
    new.reviewed_at := old.reviewed_at;
    new.review_notes := old.review_notes;
    new.stripe_account_id := old.stripe_account_id;
    new.stripe_onboarding_complete := old.stripe_onboarding_complete;

    -- Uploading or replacing a license photo re-queues it for review;
    -- other edits leave the existing review_status alone.
    if new.license_photo_path is distinct from old.license_photo_path
       and new.license_photo_path is not null then
      new.review_status := 'pending_review';
    else
      new.review_status := old.review_status;
    end if;

    -- The badge belongs to the name and license that were checked.
    -- Changing either after verification sends it back for review.
    if old.license_verified and (
         new.business_name is distinct from old.business_name
      or new.license_number is distinct from old.license_number
      or new.license_type is distinct from old.license_type
    ) then
      new.license_verified := false;
      new.review_status := case when new.license_photo_path is not null
                                then 'pending_review' else 'unverified' end;
      new.review_notes := 'Business name or license changed after verification; needs re-verification.';
    end if;
  end if;

  new.is_verified := new.license_verified;
  return new;
end;
$$;
revoke execute on function public.protect_contractor_verification_fields() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. BOOKINGS: who may change what
-- ------------------------------------------------------------
create or replace function public.protect_booking_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  is_contractor boolean;
  is_homeowner boolean;
  old_pay text;
begin
  if auth.role() = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- New requests always start open and unpriced.
    if new.contractor_id is not null and new.contractor_id = new.homeowner_id then
      raise exception 'You cannot book yourself';
    end if;
    new.status := 'pending';
    new.payment_status := 'unpaid';
    new.payment_method := 'stripe';
    new.price := null;
    new.price_amount := null;
    new.completed_at := null;
    new.cash_requested_at := null;
    new.stripe_checkout_session_id := null;
    new.stripe_payment_intent_id := null;
    return new;
  end if;

  is_contractor := uid = old.contractor_id;
  is_homeowner := uid = old.homeowner_id;
  old_pay := coalesce(old.payment_status, 'unpaid');

  if new.homeowner_id is distinct from old.homeowner_id
     or new.contractor_id is distinct from old.contractor_id
     or new.created_at is distinct from old.created_at
     or new.stripe_checkout_session_id is distinct from old.stripe_checkout_session_id
     or new.stripe_payment_intent_id is distinct from old.stripe_payment_intent_id then
    raise exception 'These booking details cannot be changed';
  end if;

  -- Price and completion time: the contractor sets them, before payment.
  if new.price_amount is distinct from old.price_amount
     or new.price is distinct from old.price
     or new.completed_at is distinct from old.completed_at then
    if not is_contractor then
      raise exception 'Only the contractor can set the price';
    end if;
    if old_pay <> 'unpaid' then
      raise exception 'The price cannot change once payment has started';
    end if;
  end if;

  -- Status: either side may cancel an open booking; only the contractor
  -- confirms or completes it; closed bookings stay closed.
  if new.status is distinct from old.status then
    if old.status in ('completed', 'cancelled') then
      raise exception 'This booking is already closed';
    end if;
    if new.status = 'cancelled' then
      null;
    elsif new.status in ('confirmed', 'completed') and is_contractor then
      null;
    else
      raise exception 'Only the contractor can confirm or complete a booking';
    end if;
  end if;

  -- Payment fields. Marking paid is decided by protect_payment_status_transitions
  -- (Stripe webhook or the contractor confirming cash). Everything else here
  -- is the homeowner choosing card vs cash before anything is paid.
  if new.payment_status is distinct from old.payment_status
     or new.payment_method is distinct from old.payment_method
     or new.cash_requested_at is distinct from old.cash_requested_at then
    if old_pay in ('paid', 'refunded') then
      raise exception 'This booking has already been paid';
    end if;
    if new.payment_status = 'refunded' then
      raise exception 'Refunds can only be recorded by Revise';
    end if;
    if new.payment_status = 'paid' then
      if new.payment_method is distinct from old.payment_method
         or new.cash_requested_at is distinct from old.cash_requested_at then
        raise exception 'Invalid payment update';
      end if;
    elsif not is_homeowner then
      raise exception 'Only the homeowner can choose how to pay';
    end if;
  end if;

  return new;
end;
$$;
revoke execute on function public.protect_booking_fields() from public, anon, authenticated;

-- Fires before protect_payment_status_transitions (triggers run in name order).
drop trigger if exists protect_booking_fields on public.bookings;
create trigger protect_booking_fields
  before insert or update on public.bookings
  for each row execute function public.protect_booking_fields();

-- ------------------------------------------------------------
-- 5. REVIEWS: only for the contractor you actually booked
-- (completion can now only be set by that contractor)
-- ------------------------------------------------------------
drop policy if exists "Homeowners can leave a review for their own booking" on public.reviews;
create policy "Homeowners can leave a review for their own booking"
  on public.reviews for insert
  to authenticated
  with check (
    auth.uid() = homeowner_id
    and exists (
      select 1 from public.bookings b
      where b.id = booking_id
        and b.homeowner_id = auth.uid()
        and b.contractor_id = reviews.contractor_id
        and b.status = 'completed'
    )
  );

-- ------------------------------------------------------------
-- 8. STORAGE: images only (plus PDF for license documents), size caps
-- ------------------------------------------------------------
update storage.buckets
  set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'],
      file_size_limit = 5 * 1024 * 1024
  where id = 'avatars';
update storage.buckets
  set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'],
      file_size_limit = 10 * 1024 * 1024
  where id = 'portfolios';
update storage.buckets
  set allowed_mime_types = array['application/pdf', 'image/jpeg', 'image/png'],
      file_size_limit = 10 * 1024 * 1024
  where id = 'license-documents';

-- ------------------------------------------------------------
-- Defense in depth: browser roles never need these privileges.
-- ------------------------------------------------------------
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;
