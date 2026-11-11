-- ============================================================================
--  Thornhill Corporation — Supabase backend setup
--  Paste this whole file into Supabase → SQL Editor → New query → Run.
--
--  Security model
--  • Visitors can ONLY submit enquiries (via submit_enquiry). They cannot read,
--    change or delete anything.
--  • The enquiries and admins tables have Row Level Security switched on with
--    NO public policies, so the public API key can't touch them directly.
--  • Admin actions go through functions that check the full name + special code
--    on the server. Codes are stored as bcrypt hashes, never in plain text.
--  • After 5 wrong codes for a name, that name is locked for 15 minutes.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- tables ----
create table if not exists public.enquiries (
  id           uuid primary key default gen_random_uuid(),
  reference    text not null unique,
  full_name    text not null check (char_length(full_name) between 2 and 120),
  email        text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' and char_length(email) <= 200),
  phone        text check (phone is null or char_length(phone) <= 40),
  category     text not null check (char_length(category) <= 60),
  subject      text not null check (char_length(subject) between 2 and 200),
  message      text not null check (char_length(message) between 10 and 5000),
  status       text not null default 'new' check (status in ('new', 'in_progress', 'resolved')),
  admin_notes  text check (admin_notes is null or char_length(admin_notes) <= 2000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.admins (
  id         uuid primary key default gen_random_uuid(),
  full_name  text not null unique,
  code_hash  text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_login_failures (
  id         bigserial primary key,
  name_key   text not null,
  failed_at  timestamptz not null default now()
);

alter table public.enquiries            enable row level security;
alter table public.admins               enable row level security;
alter table public.admin_login_failures enable row level security;
-- (No policies are created on purpose: the public key has no direct table access.)

revoke all on public.enquiries, public.admins, public.admin_login_failures from anon, authenticated;

-- ------------------------------------------------------- internal check ----
create or replace function public._thornhill_check_admin(p_name text, p_code text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key   text := lower(trim(coalesce(p_name, '')));
  v_admin public.admins;
  v_fails int;
begin
  select count(*) into v_fails
    from public.admin_login_failures
   where name_key = v_key and failed_at > now() - interval '15 minutes';

  if v_fails >= 5 then
    raise exception 'Too many attempts. Please try again in 15 minutes.' using errcode = '42501';
  end if;

  select * into v_admin from public.admins where lower(full_name) = v_key;

  if v_admin.id is null or v_admin.code_hash <> crypt(coalesce(p_code, ''), v_admin.code_hash) then
    insert into public.admin_login_failures(name_key) values (v_key);
    return null;
  end if;

  delete from public.admin_login_failures where name_key = v_key;
  return v_admin.full_name;
end;
$$;

revoke all on function public._thornhill_check_admin(text, text) from public, anon, authenticated;

-- ------------------------------------------------------ public: submit ----
create or replace function public.submit_enquiry(
  p_full_name text, p_email text, p_phone text,
  p_category text, p_subject text, p_message text
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ref text;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  loop
    v_ref := 'TH-';
    for i in 1..6 loop
      v_ref := v_ref || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.enquiries where reference = v_ref);
  end loop;

  insert into public.enquiries (reference, full_name, email, phone, category, subject, message)
  values (v_ref, trim(p_full_name), lower(trim(p_email)), nullif(trim(p_phone), ''),
          trim(p_category), trim(p_subject), trim(p_message));

  return v_ref;
end;
$$;

-- ------------------------------------------------------- admin: login ----
create or replace function public.admin_login(p_name text, p_code text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return public._thornhill_check_admin(p_name, p_code);
end;
$$;

-- -------------------------------------------------------- admin: list ----
-- Returns {"ok": true, "items": [...]} or {"ok": false}. (Not raising an error
-- keeps failed-attempt records, so the lockout can't be bypassed here.)
create or replace function public.admin_list_enquiries(p_name text, p_code text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_items json;
begin
  if public._thornhill_check_admin(p_name, p_code) is null then
    return json_build_object('ok', false);
  end if;
  select coalesce(json_agg(e order by e.created_at desc), '[]'::json) into v_items from public.enquiries e;
  return json_build_object('ok', true, 'items', v_items);
end;
$$;

-- ------------------------------------------------------ admin: update ----
create or replace function public.admin_update_enquiry(
  p_name text, p_code text, p_id uuid, p_status text, p_notes text
) returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public._thornhill_check_admin(p_name, p_code) is null then
    return null;  -- null = not authorised
  end if;
  if p_status not in ('new', 'in_progress', 'resolved') then
    return false;
  end if;
  update public.enquiries
     set status = p_status, admin_notes = nullif(trim(p_notes), ''), updated_at = now()
   where id = p_id;
  return found;
end;
$$;

-- ------------------------------------------------------ admin: delete ----
create or replace function public.admin_delete_enquiry(p_name text, p_code text, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public._thornhill_check_admin(p_name, p_code) is null then
    return null;  -- null = not authorised
  end if;
  delete from public.enquiries where id = p_id;
  return found;
end;
$$;

grant execute on function public.submit_enquiry(text, text, text, text, text, text)        to anon, authenticated;
grant execute on function public.admin_login(text, text)                                    to anon, authenticated;
grant execute on function public.admin_list_enquiries(text, text)                           to anon, authenticated;
grant execute on function public.admin_update_enquiry(text, text, uuid, text, text)         to anon, authenticated;
grant execute on function public.admin_delete_enquiry(text, text, uuid)                     to anon, authenticated;

-- ============================================================================
--  ADD YOUR ADMINISTRATORS
--  Change the name and code below, then run just these lines.
--  Use a long, hard-to-guess code (e.g. 12+ characters, letters and numbers).
--  Run once per admin. The code is hashed — you can't read it back later.
-- ============================================================================
-- insert into public.admins (full_name, code_hash)
-- values ('Your Full Name', extensions.crypt('CHANGE-ME-TO-A-LONG-CODE', extensions.gen_salt('bf')));

-- Change an admin's code:
-- update public.admins set code_hash = extensions.crypt('NEW-LONG-CODE', extensions.gen_salt('bf'))
--  where lower(full_name) = lower('Your Full Name');

-- Remove an admin:
-- delete from public.admins where lower(full_name) = lower('Their Full Name');
