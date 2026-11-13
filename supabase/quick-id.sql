-- ============================================================================
--  Thornhill Corporation — Thornhill ID (sign in to a computer with your phone)
--  A computer shows a code / QR code. The staff member unlocks their
--  Thornhill ID on their phone (Thornhill Quick: fingerprint / face / PIN),
--  enters or scans the code and taps Approve. The computer is then signed in.
--  Run AFTER quick.sql. Safe to run again. No function changes needed.
-- ============================================================================

create table if not exists public.quick_links (
  id                uuid primary key default gen_random_uuid(),
  code              text not null,
  poll_secret_hash  text not null,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'used')),
  admin_id          uuid references public.admins(id) on delete cascade,
  computer_label    text,
  token             text,               -- handed to the computer once, then cleared
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '3 minutes',
  decided_at        timestamptz
);
create index if not exists quick_links_code_idx on public.quick_links (code);
alter table public.quick_links enable row level security;
revoke all on public.quick_links from anon, authenticated;

-- Computer: ask for a sign-in code. Returns the code (shown on screen) and a secret only this computer knows.
create or replace function public.quick_link_start(p_label text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_secret text := encode(gen_random_bytes(24), 'hex');
  v_row public.quick_links;
  i int;
begin
  delete from public.quick_links where expires_at < now() - interval '10 minutes';
  if (select count(*) from public.quick_links where status = 'pending' and expires_at > now()) > 500 then
    return json_build_object('ok', false, 'error', 'Too many sign-in requests right now. Please try again in a minute.');
  end if;
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_chars, 1 + (get_byte(gen_random_bytes(1), 0) % length(v_chars)), 1);
    end loop;
    exit when not exists (select 1 from public.quick_links where code = v_code and expires_at > now());
  end loop;
  insert into public.quick_links (code, poll_secret_hash, computer_label)
  values (v_code, encode(digest(v_secret, 'sha256'), 'hex'), left(nullif(trim(p_label), ''), 80))
  returning * into v_row;
  return json_build_object('ok', true, 'id', v_row.id, 'code', v_code, 'secret', v_secret, 'expires_at', v_row.expires_at);
end;
$$;

-- Computer: check whether the phone has approved yet. The sign-in token is handed over once.
create or replace function public.quick_link_poll(p_id uuid, p_secret text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_row public.quick_links;
  v_name text;
begin
  select * into v_row from public.quick_links
   where id = p_id and poll_secret_hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex');
  if v_row.id is null then return json_build_object('status', 'expired'); end if;
  if v_row.status = 'approved' and v_row.token is not null then
    update public.quick_links set status = 'used', token = null where id = v_row.id;
    select full_name into v_name from public.admins where id = v_row.admin_id;
    return json_build_object('status', 'approved', 'name', v_name, 'token', v_row.token);
  end if;
  if v_row.status = 'pending' and v_row.expires_at < now() then return json_build_object('status', 'expired'); end if;
  return json_build_object('status', v_row.status);
end;
$$;

-- Phone: what is asking to sign in with this code?  (Must be signed in with Thornhill Quick.)
create or replace function public.admin_quick_link_lookup(p_name text, p_code text, p_link_code text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_row public.quick_links;
begin
  if coalesce(p_code, '') not like 'tq\_%' or public._thornhill_check_admin(p_name, p_code) is null then
    return json_build_object('ok', false, 'auth', false);
  end if;
  select * into v_row from public.quick_links
   where code = upper(regexp_replace(coalesce(p_link_code, ''), '[^A-Za-z0-9]', '', 'g'))
     and status = 'pending' and expires_at > now()
   order by created_at desc limit 1;
  if v_row.id is null then
    return json_build_object('ok', false, 'error', 'That code isn''t valid or has expired. Check the code on the computer.');
  end if;
  return json_build_object('ok', true, 'computer', coalesce(v_row.computer_label, 'A computer'), 'requested_at', v_row.created_at, 'expires_at', v_row.expires_at);
end;
$$;

-- Phone: approve or deny. Approving signs the computer in as you for 12 hours.
create or replace function public.admin_quick_link_decide(p_name text, p_code text, p_link_code text, p_approve boolean)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_name text;
  v_admin uuid;
  v_row public.quick_links;
  v_token text := 'tq_' || encode(gen_random_bytes(32), 'hex');
begin
  if coalesce(p_code, '') not like 'tq\_%' then return json_build_object('ok', false, 'auth', false); end if;
  v_name := public._thornhill_check_admin(p_name, p_code);
  if v_name is null then return json_build_object('ok', false, 'auth', false); end if;
  select id into v_admin from public.admins where lower(full_name) = lower(v_name);
  select * into v_row from public.quick_links
   where code = upper(regexp_replace(coalesce(p_link_code, ''), '[^A-Za-z0-9]', '', 'g'))
     and status = 'pending' and expires_at > now()
   order by created_at desc limit 1
   for update;
  if v_row.id is null then
    return json_build_object('ok', false, 'error', 'That code isn''t valid or has expired. Start again on the computer.');
  end if;
  if not coalesce(p_approve, false) then
    update public.quick_links set status = 'denied', decided_at = now(), admin_id = v_admin where id = v_row.id;
    return json_build_object('ok', true, 'status', 'denied');
  end if;
  insert into public.admin_sessions (admin_id, token_hash, via, device_label)
  values (v_admin, encode(digest(v_token, 'sha256'), 'hex'), 'thornhill-id', coalesce(v_row.computer_label, 'Computer'));
  update public.quick_links set status = 'approved', decided_at = now(), admin_id = v_admin, token = v_token where id = v_row.id;
  return json_build_object('ok', true, 'status', 'approved', 'computer', v_row.computer_label);
end;
$$;

-- Phone: details for the Thornhill ID card
create or replace function public.admin_id_card(p_name text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_name text := public._thornhill_check_admin(p_name, p_code);
  v_a public.admins;
begin
  if v_name is null then return json_build_object('ok', false, 'auth', false); end if;
  select * into v_a from public.admins where lower(full_name) = lower(v_name);
  return json_build_object('ok', true,
    'full_name', v_a.full_name,
    'id_number', 'TH-' || upper(substr(replace(v_a.id::text, '-', ''), 1, 4)) || '-' || upper(substr(replace(v_a.id::text, '-', ''), 5, 4)),
    'role', 'Administrator',
    'since', v_a.created_at,
    'devices', (select count(*) from public.quick_credentials where admin_id = v_a.id),
    'recent', (select coalesce(json_agg(json_build_object('device', s.device_label, 'via', s.via, 'at', s.created_at, 'active', (not s.revoked and s.expires_at > now()))
                 order by s.created_at desc), '[]'::json)
                 from (select * from public.admin_sessions where admin_id = v_a.id order by created_at desc limit 6) s));
end;
$$;

grant execute on function public.quick_link_start(text) to anon, authenticated;
grant execute on function public.quick_link_poll(uuid, text) to anon, authenticated;
grant execute on function public.admin_quick_link_lookup(text, text, text) to anon, authenticated;
grant execute on function public.admin_quick_link_decide(text, text, text, boolean) to anon, authenticated;
grant execute on function public.admin_id_card(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
