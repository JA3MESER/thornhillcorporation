-- ============================================================================
--  Thornhill Corporation — Redirects (short links)
--  e.g. redirects.thornhillcorporation.co.uk/Roblox/Thornhill  →  Roblox page
--  Run in Supabase → SQL Editor → New query → Run. Safe to run again.
-- ============================================================================

create table if not exists public.redirects (
  id           uuid primary key default gen_random_uuid(),
  path         text not null check (path ~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$' and char_length(path) <= 100),
  destination  text not null check (destination ~* '^https?://[^\s]+$' and char_length(destination) <= 2000),
  label        text check (label is null or char_length(label) <= 150),
  clicks       integer not null default 0,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Short links are not case-sensitive: /roblox/thornhill = /Roblox/Thornhill
create unique index if not exists redirects_path_unique on public.redirects (lower(path));

alter table public.redirects enable row level security;
revoke all on public.redirects from anon, authenticated;

create or replace function public.admin_list_redirects(p_name text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_items json;
begin
  if public._thornhill_check_admin(p_name, p_code) is null then
    return json_build_object('ok', false);
  end if;
  select coalesce(json_agg(json_build_object(
           'id', r.id, 'path', r.path, 'destination', r.destination, 'label', r.label,
           'clicks', r.clicks, 'created_by', r.created_by,
           'created_at', r.created_at, 'updated_at', r.updated_at
         ) order by lower(r.path)), '[]'::json)
    into v_items from public.redirects r;
  return json_build_object('ok', true, 'items', v_items);
end;
$$;

create or replace function public.admin_save_redirect(
  p_name text, p_code text, p_id uuid, p_path text, p_destination text, p_label text
) returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
  v_path  text := regexp_replace(trim(coalesce(p_path, '')), '^/+|/+$', '', 'g');
  v_id    uuid;
begin
  if v_admin is null then
    return json_build_object('ok', false, 'auth', false);
  end if;
  if lower(split_part(v_path, '/', 1)) in ('assets', 'd', 'index.html', '404.html', 'cname') then
    return json_build_object('ok', false, 'error', 'That short link is reserved by the website. Please choose another.');
  end if;
  if exists (select 1 from public.redirects where lower(path) = lower(v_path) and id is distinct from p_id) then
    return json_build_object('ok', false, 'error', 'That short link is already in use. Please choose another.');
  end if;
  begin
    if p_id is null then
      insert into public.redirects (path, destination, label, created_by)
      values (v_path, trim(p_destination), nullif(trim(p_label), ''), v_admin)
      returning id into v_id;
    else
      update public.redirects
         set path = v_path, destination = trim(p_destination), label = nullif(trim(p_label), ''), updated_at = now()
       where id = p_id
      returning id into v_id;
      if v_id is null then
        return json_build_object('ok', false, 'error', 'That redirect no longer exists.');
      end if;
    end if;
  exception when check_violation or not_null_violation then
    return json_build_object('ok', false, 'error', 'Please check the details: the short link can use letters, numbers, dashes, dots, underscores and slashes, and the destination must start with https://');
  end;
  return json_build_object('ok', true, 'id', v_id, 'path', v_path);
end;
$$;

create or replace function public.admin_delete_redirect(p_name text, p_code text, p_id uuid)
returns boolean language plpgsql security definer set search_path = public, extensions
as $$
begin
  if public._thornhill_check_admin(p_name, p_code) is null then
    return null;
  end if;
  delete from public.redirects where id = p_id;
  return found;
end;
$$;

-- Public: look up a short link and count the click. Returns the destination, or null.
create or replace function public.resolve_redirect(p_path text)
returns text language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_dest text;
begin
  update public.redirects set clicks = clicks + 1
   where lower(path) = lower(regexp_replace(trim(coalesce(p_path, '')), '^/+|/+$', '', 'g'))
  returning destination into v_dest;
  return v_dest;
end;
$$;

grant execute on function public.admin_list_redirects(text, text) to anon, authenticated;
grant execute on function public.admin_save_redirect(text, text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.admin_delete_redirect(text, text, uuid) to anon, authenticated;
grant execute on function public.resolve_redirect(text) to anon, authenticated;

notify pgrst, 'reload schema';
