-- ============================================================================
--  Thornhill Corporation — Thornhill Quick PIN (trusted PCs)
--  Run this ONCE in Supabase → SQL Editor, after quick.sql. Safe to run again.
--
--  How it works: after signing in properly once, a staff member can trust
--  their own PC and choose a 6-digit PIN. The PC keeps a long random secret
--  (256-bit); the database keeps only scrambled copies of the secret and PIN.
--  To sign in, BOTH are needed: the secret that only that PC has, and the
--  PIN only the staff member knows. 5 wrong PINs and the PC is forgotten.
-- ============================================================================

create table if not exists public.trusted_devices (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references public.admins(id) on delete cascade,
  secret_hash   text not null unique,
  pin_hash      text not null,
  label         text check (label is null or char_length(label) <= 80),
  failed_pins   integer not null default 0,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  expires_at    timestamptz not null default now() + interval '60 days'
);
alter table public.trusted_devices enable row level security;
revoke all on public.trusted_devices from anon, authenticated;

-- PINs that are too easy to guess
create or replace function public._pin_is_weak(p_pin text)
returns boolean language sql immutable as $$
  select p_pin ~ '^(\d)\1{5}$'                                   -- 000000, 111111 …
      or '0123456789012345' like '%' || p_pin || '%'           -- 123456, 345678 …
      or '9876543210987654' like '%' || p_pin || '%'           -- 654321 …
      or p_pin ~ '^(\d\d)\1\1$' or p_pin ~ '^(\d\d\d)\1$'       -- 121212, 123123
      or p_pin in ('112233', '445566', '778899', '696969', '420420', '102030', '159753', '147258', '258369');
$$;
revoke all on function public._pin_is_weak(text) from public, anon, authenticated;

-- ------------------------------------------------ signed in: trust this PC ----
create or replace function public.admin_pin_setup(p_name text, p_code text, p_pin text, p_label text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_name   text := public._thornhill_check_admin(p_name, p_code);
  v_admin  uuid;
  v_secret text := 'td_' || encode(gen_random_bytes(32), 'hex');
  v_id     uuid;
begin
  if v_name is null then return json_build_object('ok', false, 'auth', false); end if;
  if coalesce(p_pin, '') !~ '^\d{6}$' then
    return json_build_object('ok', false, 'error', 'Your PIN must be exactly 6 numbers.');
  end if;
  if public._pin_is_weak(p_pin) then
    return json_build_object('ok', false, 'error', 'That PIN is too easy to guess. Try a less obvious one.');
  end if;
  select id into v_admin from public.admins where lower(full_name) = lower(v_name);

  insert into public.trusted_devices (admin_id, secret_hash, pin_hash, label)
  values (v_admin, encode(digest(v_secret, 'sha256'), 'hex'), crypt(p_pin, gen_salt('bf', 10)),
          left(nullif(trim(coalesce(p_label, '')), ''), 80))
  returning id into v_id;

  -- Keep at most 5 trusted PCs per person (the oldest are forgotten)
  delete from public.trusted_devices where id in (
    select id from public.trusted_devices where admin_id = v_admin order by created_at desc offset 5);

  return json_build_object('ok', true, 'device', v_id, 'secret', v_secret, 'name', v_name);
end;
$$;

-- ------------------------------------- public: who is this PC trusted for? ----
create or replace function public.pin_device_info(p_device uuid, p_secret text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare v_name text;
begin
  select a.full_name into v_name from public.trusted_devices d join public.admins a on a.id = d.admin_id
   where d.id = p_device and d.secret_hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex') and d.expires_at > now();
  if v_name is null then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'name', v_name);
end;
$$;

-- ---------------------------------------------- public: sign in with PIN ----
create or replace function public.pin_sign_in(p_device uuid, p_secret text, p_pin text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_d     public.trusted_devices;
  v_name  text;
  v_token text := 'tq_' || encode(gen_random_bytes(32), 'hex');
begin
  delete from public.trusted_devices where expires_at < now();

  select * into v_d from public.trusted_devices
   where id = p_device and secret_hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex')
   for update;
  if v_d.id is null then return json_build_object('ok', false, 'forgotten', true); end if;

  if v_d.pin_hash <> crypt(coalesce(p_pin, ''), v_d.pin_hash) then
    if v_d.failed_pins + 1 >= 5 then
      delete from public.trusted_devices where id = v_d.id;
      return json_build_object('ok', false, 'forgotten', true, 'locked', true);
    end if;
    update public.trusted_devices set failed_pins = failed_pins + 1 where id = v_d.id;
    return json_build_object('ok', false, 'remaining', 4 - v_d.failed_pins);
  end if;

  update public.trusted_devices
     set failed_pins = 0, last_used_at = now(), expires_at = now() + interval '60 days'
   where id = v_d.id;
  insert into public.admin_sessions (admin_id, token_hash, via, device_label)
  values (v_d.admin_id, encode(digest(v_token, 'sha256'), 'hex'), 'pin', v_d.label);
  delete from public.admin_sessions where expires_at < now() - interval '7 days';
  select full_name into v_name from public.admins where id = v_d.admin_id;
  return json_build_object('ok', true, 'name', v_name, 'token', v_token);
end;
$$;

-- ---------------------------------------- signed in: list / forget my PCs ----
create or replace function public.admin_pin_devices(p_name text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare v_name text := public._thornhill_check_admin(p_name, p_code);
begin
  if v_name is null then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'devices', (
    select coalesce(json_agg(json_build_object('id', d.id, 'label', d.label, 'created_at', d.created_at,
             'last_used_at', d.last_used_at, 'expires_at', d.expires_at) order by d.created_at), '[]'::json)
      from public.trusted_devices d join public.admins a on a.id = d.admin_id
     where lower(a.full_name) = lower(v_name) and d.expires_at > now()));
end;
$$;

create or replace function public.admin_pin_remove(p_name text, p_code text, p_id uuid)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare v_name text := public._thornhill_check_admin(p_name, p_code);
begin
  if v_name is null then return json_build_object('ok', false); end if;
  delete from public.trusted_devices d using public.admins a
   where d.id = p_id and d.admin_id = a.id and lower(a.full_name) = lower(v_name);
  return json_build_object('ok', true);
end;
$$;

-- "Sign out everywhere" now also forgets every trusted PC
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
    delete from public.trusted_devices d using public.admins a
     where d.admin_id = a.id and lower(a.full_name) = lower(v_name);
  elsif p_code like 'tq\_%' then
    update public.admin_sessions set revoked = true where token_hash = encode(digest(p_code, 'sha256'), 'hex');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.admin_pin_setup(text, text, text, text) to anon, authenticated;
grant execute on function public.pin_device_info(uuid, text) to anon, authenticated;
grant execute on function public.pin_sign_in(uuid, text, text) to anon, authenticated;
grant execute on function public.admin_pin_devices(text, text) to anon, authenticated;
grant execute on function public.admin_pin_remove(text, text, uuid) to anon, authenticated;
