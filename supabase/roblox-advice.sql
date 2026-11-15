-- ============================================================================
--  Thornhill Corporation — Roblox Advice + data protection update
--  Run this ONCE in Supabase → SQL Editor. Safe to run again.
--
--  1. Turns the old legal enquiry form into the Roblox Advice Request form
--     (existing records are carried over and relabelled).
--  2. Locks the database down further: every table private, internal
--     functions hidden, and submission limits to stop spam.
--  3. Adds automatic data retention, so personal data isn't kept forever.
-- ============================================================================


-- ===================================================== 1. Roblox Advice ====

-- Record type: 'support' or 'advice' (old 'legal' records become 'advice')
alter table public.enquiries add column if not exists kind text not null default 'support';
alter table public.enquiries drop constraint if exists enquiries_kind_check;
update public.enquiries set kind = 'advice' where kind = 'legal';
alter table public.enquiries add constraint enquiries_kind_check check (kind in ('support', 'advice'));

-- The extra form answers live in the "advice" column (renamed from "legal" if it exists)
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'enquiries' and column_name = 'legal')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'enquiries' and column_name = 'advice') then
    alter table public.enquiries rename column legal to advice;
  end if;
end $$;
alter table public.enquiries add column if not exists advice jsonb;

-- Carry old answers over to the new field names
update public.enquiries
   set advice = (advice - 'jurisdiction' - 'proceed')
                || jsonb_build_object('region', advice->>'jurisdiction', 'acknowledged', advice->>'proceed')
 where advice ? 'jurisdiction';
update public.enquiries set category = 'Roblox advice' where category = 'Legal enquiry';

drop function if exists public.submit_legal_enquiry(text, text, text, text, text, text, text, text);

-- ------------------------------------------- public: submit an advice request ----
create or replace function public.submit_roblox_advice(
  p_full_name text, p_email text, p_subject text, p_details text,
  p_priority text, p_region text, p_acknowledged text, p_notes text,
  p_uk_resident boolean, p_age_confirmed boolean
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ref   text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if char_length(trim(coalesce(p_full_name, ''))) not between 2 and 120 then raise exception 'Please enter your name.'; end if;
  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or char_length(v_email) > 200 then raise exception 'Please enter a valid email address.'; end if;
  if char_length(trim(coalesce(p_subject, ''))) not between 2 and 200 then raise exception 'Please give your request a subject.'; end if;
  if char_length(trim(coalesce(p_details, ''))) not between 10 and 5000 then raise exception 'Please describe what you need advice with.'; end if;
  if char_length(coalesce(p_notes, '')) > 5000 then raise exception 'Additional information is too long.'; end if;
  if p_priority not in ('Low', 'Medium', 'High', 'Urgent') then raise exception 'Please choose a priority.'; end if;
  if p_region not in ('England', 'Wales', 'Scotland', 'Northern Ireland') then
    raise exception 'Roblox Advice is only available to people who live in the United Kingdom.';
  end if;
  if p_acknowledged is distinct from 'Yes' then
    raise exception 'You need to confirm you understand our advice is general guidance only.';
  end if;
  if p_uk_resident is not true then raise exception 'Roblox Advice is only available to people who live in the United Kingdom.'; end if;
  if p_age_confirmed is not true then raise exception 'Please confirm you are 13 or over, or that a parent or guardian is completing this form.'; end if;

  -- Spam protection: at most 3 requests per email address per hour, 100 per hour overall
  if (select count(*) from public.enquiries where email = v_email and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.enquiries where created_at > now() - interval '1 hour') >= 100 then
    raise exception 'Too many requests. Please try again later.';
  end if;

  loop
    v_ref := 'TH-';
    for i in 1..6 loop
      v_ref := v_ref || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.enquiries where reference = v_ref);
  end loop;

  insert into public.enquiries (reference, kind, full_name, email, category, subject, message, advice)
  values (v_ref, 'advice', trim(p_full_name), v_email, 'Roblox advice', trim(p_subject), trim(p_details),
          jsonb_build_object(
            'priority', p_priority, 'region', p_region, 'acknowledged', p_acknowledged,
            'notes', nullif(trim(coalesce(p_notes, '')), ''),
            'uk_resident', true, 'age_confirmed', true, 'privacy_notice', '2026-11-15'));
  return v_ref;
end;
$$;

grant execute on function public.submit_roblox_advice(text, text, text, text, text, text, text, text, boolean, boolean) to anon, authenticated;

-- ------------------------------------ public: support form (now spam-limited) ----
create or replace function public.submit_enquiry(
  p_full_name text, p_email text, p_phone text,
  p_category text, p_subject text, p_message text
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ref   text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if (select count(*) from public.enquiries where email = v_email and created_at > now() - interval '1 hour') >= 3
     or (select count(*) from public.enquiries where created_at > now() - interval '1 hour') >= 100 then
    raise exception 'Too many enquiries. Please try again later.';
  end if;

  loop
    v_ref := 'TH-';
    for i in 1..6 loop
      v_ref := v_ref || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.enquiries where reference = v_ref);
  end loop;

  insert into public.enquiries (reference, full_name, email, phone, category, subject, message)
  values (v_ref, trim(p_full_name), v_email, nullif(trim(p_phone), ''),
          trim(p_category), trim(p_subject), trim(p_message));
  return v_ref;
end;
$$;

-- Reply template for advice requests
update public.email_templates set name = 'Roblox advice reply' where name = 'Legal enquiry reply';
update public.email_templates set body =
'Hi {{name}},

Thanks for sending Thornhill Corporation a Roblox Advice request about "{{enquiry_subject}}". Your reference is {{reference}}.



Please remember this is general guidance from a Roblox Developer, not legal, financial or professional advice. Never share your Roblox password or 2-Step Verification codes with anyone, including us.

Kind regards,
{{admin_name}}
Roblox Developer, Thornhill Corporation'
 where name = 'Roblox advice reply';
insert into public.email_templates (name, subject, body, created_by)
select 'Roblox advice reply', null,
'Hi {{name}},

Thanks for sending Thornhill Corporation a Roblox Advice request about "{{enquiry_subject}}". Your reference is {{reference}}.



Please remember this is general guidance from a Roblox Developer, not legal, financial or professional advice. Never share your Roblox password or 2-Step Verification codes with anyone, including us.

Kind regards,
{{admin_name}}
Roblox Developer, Thornhill Corporation', 'Thornhill'
where not exists (select 1 from public.email_templates where name = 'Roblox advice reply');


-- =================================================== 2. Lock it all down ====

-- Every table: row level security on, and no direct access from the website's
-- public key. The website can only use the specific functions granted above.
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('revoke all on table public.%I from anon, authenticated', r.tablename);
  end loop;
  for r in select sequence_name from information_schema.sequences where sequence_schema = 'public' loop
    execute format('revoke all on sequence public.%I from anon, authenticated', r.sequence_name);
  end loop;
end $$;

-- New tables created later are private by default too
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- Internal helper functions (names starting with _) can never be called from outside
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like '\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;


-- ================================================== 3. Data retention =====
--  • Enquiries and advice requests: deleted 12 months after they are resolved/
--    closed, and in any case 24 months after the last activity.
--  • Emails: deleted after 24 months (and with their enquiry).
--  • Sign-in records: failed attempts after 30 days, expired sessions/codes after 30 days.
--  Runs automatically each time an administrator signs in.

create or replace function public._thornhill_purge_expired()
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ids uuid[];
  v_enq int := 0;
  v_mail int := 0;
begin
  select coalesce(array_agg(id), '{}') into v_ids from public.enquiries
   where (status = 'resolved' and updated_at < now() - interval '12 months')
      or updated_at < now() - interval '24 months';

  if to_regclass('public.emails') is not null then
    delete from public.emails where enquiry_id = any(v_ids) or created_at < now() - interval '24 months';
    get diagnostics v_mail = row_count;
  end if;

  delete from public.enquiries where id = any(v_ids);
  get diagnostics v_enq = row_count;

  delete from public.admin_login_failures where failed_at < now() - interval '30 days';
  if to_regclass('public.admin_sessions') is not null then
    delete from public.admin_sessions where expires_at < now() - interval '30 days';
  end if;
  if to_regclass('public.quick_challenges') is not null then
    delete from public.quick_challenges where expires_at < now() - interval '1 day';
  end if;
  if to_regclass('public.quick_links') is not null then
    delete from public.quick_links where expires_at < now() - interval '1 day';
  end if;

  return json_build_object('enquiries', v_enq, 'emails', v_mail);
end;
$$;
revoke all on function public._thornhill_purge_expired() from public, anon, authenticated;

create or replace function public.admin_purge_expired(p_name text, p_code text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public._thornhill_check_admin(p_name, p_code) is null then
    return json_build_object('ok', false);
  end if;
  return json_build_object('ok', true, 'removed', public._thornhill_purge_expired());
end;
$$;
grant execute on function public.admin_purge_expired(text, text) to anon, authenticated;
