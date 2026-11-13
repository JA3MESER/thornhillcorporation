-- ============================================================================
--  Thornhill Corporation — Thornhill Quick (passkey sign-in)
--  Staff sign in once with their name + code, then register their device.
--  After that they can sign in with their fingerprint, face or device PIN.
--  Passkeys are checked by the "quick" Edge Function; this file stores them
--  and issues short-lived sign-in sessions.
--  Run AFTER setup.sql. Safe to run again.
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.quick_credentials (
  id             uuid primary key default gen_random_uuid(),
  admin_id       uuid not null references public.admins(id) on delete cascade,
  credential_id  text not null unique,           -- base64url
  public_key     text not null,                  -- SPKI, base64
  alg            integer not null check (alg in (-7, -257)),
  sign_count     bigint not null default 0,
  label          text check (label is null or char_length(label) <= 80),
  transports     text[] not null default '{}',
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

create table if not exists public.quick_challenges (
  id          uuid primary key default gen_random_uuid(),
  challenge   text not null,
  purpose     text not null check (purpose in ('register', 'login')),
  admin_id    uuid references public.admins(id) on delete cascade,
  expires_at  timestamptz not null default now() + interval '5 minutes'
);

create table if not exists public.admin_sessions (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references public.admins(id) on delete cascade,
  token_hash    text not null unique,
  via           text not null default 'quick',
  device_label  text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '12 hours',
  revoked       boolean not null default false
);

alter table public.quick_credentials enable row level security;
alter table public.quick_challenges  enable row level security;
alter table public.admin_sessions    enable row level security;
revoke all on public.quick_credentials, public.quick_challenges, public.admin_sessions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- The one admin check used everywhere now also accepts Thornhill Quick
-- sessions: p_code may be a sign-in token ("tq_…") instead of the special code.
-- ---------------------------------------------------------------------------
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
  -- Thornhill Quick session token (random, 256-bit — can't be guessed, so no lockout counting)
  if coalesce(p_code, '') like 'tq\_%' then
    select a.* into v_admin from public.admins a
      join public.admin_sessions s on s.admin_id = a.id
     where lower(a.full_name) = v_key
       and s.token_hash = encode(digest(p_code, 'sha256'), 'hex')
       and not s.revoked and s.expires_at > now();
    if v_admin.id is null then return null; end if;
    update public.admin_sessions set last_used_at = now()
     where token_hash = encode(digest(p_code, 'sha256'), 'hex') and last_used_at < now() - interval '1 minute';
    return v_admin.full_name;
  end if;

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

-- ---------------------------------------------------------------------------
-- Admin-facing: my Thornhill Quick devices, remove one, sign out everywhere
-- ---------------------------------------------------------------------------
create or replace function public.admin_quick_overview(p_name text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_name text := public._thornhill_check_admin(p_name, p_code);
  v_id uuid;
begin
  if v_name is null then return json_build_object('ok', false); end if;
  select id into v_id from public.admins where lower(full_name) = lower(v_name);
  return json_build_object('ok', true,
    'devices', (select coalesce(json_agg(json_build_object('id', c.id, 'label', c.label, 'created_at', c.created_at,
                  'last_used_at', c.last_used_at) order by c.created_at), '[]'::json)
                  from public.quick_credentials c where c.admin_id = v_id),
    'sessions', (select count(*) from public.admin_sessions s where s.admin_id = v_id and not s.revoked and s.expires_at > now()),
    'last_quick_sign_in', (select max(created_at) from public.admin_sessions s where s.admin_id = v_id));
end;
$$;

create or replace function public.admin_quick_remove_device(p_name text, p_code text, p_id uuid)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_name text := public._thornhill_check_admin(p_name, p_code);
begin
  if v_name is null then return json_build_object('ok', false); end if;
  delete from public.quick_credentials c using public.admins a
   where c.id = p_id and c.admin_id = a.id and lower(a.full_name) = lower(v_name);
  return json_build_object('ok', true);
end;
$$;

-- p_everywhere: also end every other Thornhill Quick session for this admin
create or replace function public.admin_sign_out(p_name text, p_code text, p_everywhere boolean)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_name text := public._thornhill_check_admin(p_name, p_code);
begin
  if v_name is null then return json_build_object('ok', true); end if;
  if coalesce(p_everywhere, false) then
    update public.admin_sessions s set revoked = true from public.admins a
     where s.admin_id = a.id and lower(a.full_name) = lower(v_name) and not s.revoked;
  elsif p_code like 'tq\_%' then
    update public.admin_sessions set revoked = true where token_hash = encode(digest(p_code, 'sha256'), 'hex');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.admin_quick_overview(text, text) to anon, authenticated;
grant execute on function public.admin_quick_remove_device(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_sign_out(text, text, boolean) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Used only by the "quick" Edge Function (service role)
-- ---------------------------------------------------------------------------
create or replace function public._quick_new_challenge(p_purpose text, p_name text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin public.admins;
  v_row public.quick_challenges;
  v_name text;
begin
  delete from public.quick_challenges where expires_at < now();
  if p_purpose = 'register' then
    v_name := public._thornhill_check_admin(p_name, p_code);
    if v_name is null then return json_build_object('ok', false, 'auth', false); end if;
    select * into v_admin from public.admins where lower(full_name) = lower(v_name);
  end if;
  insert into public.quick_challenges (challenge, purpose, admin_id)
  values (translate(rtrim(encode(gen_random_bytes(32), 'base64'), '='), '+/', '-_'), p_purpose, v_admin.id)
  returning * into v_row;
  return json_build_object('ok', true, 'id', v_row.id, 'challenge', v_row.challenge,
    'admin', case when v_admin.id is null then null else json_build_object('id', v_admin.id, 'full_name', v_admin.full_name) end,
    'exclude', case when v_admin.id is null then '[]'::json else
      (select coalesce(json_agg(credential_id), '[]'::json) from public.quick_credentials where admin_id = v_admin.id) end);
end;
$$;

-- Single use: returns the challenge and deletes it
create or replace function public._quick_take_challenge(p_id uuid, p_purpose text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_row public.quick_challenges;
begin
  delete from public.quick_challenges where id = p_id and purpose = p_purpose and expires_at > now()
  returning * into v_row;
  if v_row.id is null then return null; end if;
  return json_build_object('challenge', v_row.challenge, 'admin_id', v_row.admin_id);
end;
$$;

create or replace function public._quick_save_credential(p_admin uuid, p_credential_id text, p_public_key text, p_alg integer,
                                                         p_sign_count bigint, p_label text, p_transports text[])
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare v_id uuid;
begin
  insert into public.quick_credentials (admin_id, credential_id, public_key, alg, sign_count, label, transports)
  values (p_admin, p_credential_id, p_public_key, p_alg, coalesce(p_sign_count, 0), left(nullif(trim(p_label), ''), 80), coalesce(p_transports, '{}'))
  returning id into v_id;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public._quick_get_credential(p_credential_id text)
returns json language sql stable security definer set search_path = public, extensions
as $$
  select json_build_object('id', c.id, 'admin_id', c.admin_id, 'public_key', c.public_key, 'alg', c.alg,
                           'sign_count', c.sign_count, 'label', c.label, 'full_name', a.full_name)
    from public.quick_credentials c join public.admins a on a.id = c.admin_id
   where c.credential_id = p_credential_id;
$$;

-- Passkey checked OK → record use and start a 12-hour session. Returns the token once.
create or replace function public._quick_start_session(p_credential uuid, p_sign_count bigint)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_c public.quick_credentials;
  v_token text := 'tq_' || encode(gen_random_bytes(32), 'hex');
  v_name text;
begin
  update public.quick_credentials
     set sign_count = greatest(sign_count, coalesce(p_sign_count, 0)), last_used_at = now()
   where id = p_credential returning * into v_c;
  if v_c.id is null then return null; end if;
  insert into public.admin_sessions (admin_id, token_hash, via, device_label)
  values (v_c.admin_id, encode(digest(v_token, 'sha256'), 'hex'), 'quick', v_c.label);
  delete from public.admin_sessions where expires_at < now() - interval '7 days';
  select full_name into v_name from public.admins where id = v_c.admin_id;
  return json_build_object('ok', true, 'name', v_name, 'token', v_token);
end;
$$;

revoke all on function public._quick_new_challenge(text, text, text) from public, anon, authenticated;
revoke all on function public._quick_take_challenge(uuid, text) from public, anon, authenticated;
revoke all on function public._quick_save_credential(uuid, text, text, integer, bigint, text, text[]) from public, anon, authenticated;
revoke all on function public._quick_get_credential(text) from public, anon, authenticated;
revoke all on function public._quick_start_session(uuid, bigint) from public, anon, authenticated;
grant execute on function public._quick_new_challenge(text, text, text) to service_role;
grant execute on function public._quick_take_challenge(uuid, text) to service_role;
grant execute on function public._quick_save_credential(uuid, text, text, integer, bigint, text, text[]) to service_role;
grant execute on function public._quick_get_credential(text) to service_role;
grant execute on function public._quick_start_session(uuid, bigint) to service_role;
grant execute on function public._thornhill_check_admin(text, text) to service_role;

notify pgrst, 'reload schema';
