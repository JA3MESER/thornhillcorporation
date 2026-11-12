-- ============================================================================
--  Thornhill Corporation — Document hub (add-on)
--  Run this AFTER setup.sql. Paste the whole file into Supabase → SQL Editor →
--  New query → Run. Safe to run again.
--
--  • Admins (checked by full name + special code, same as enquiries) can add,
--    edit and delete documents: a Google Docs/Drive link or an uploaded PDF.
--  • Each document gets a short Thornhill link: /d/<short-name>
--  • Anyone with the link can view that document. Documents marked "public"
--    are also listed on the /documents page.
--  • PDFs are stored in the database (max 5 MB each).
-- ============================================================================

create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$'),
  title        text not null check (char_length(title) between 2 and 150),
  description  text check (description is null or char_length(description) <= 1000),
  kind         text not null check (kind in ('google', 'pdf')),
  url          text check (url is null or (url ~* '^https://' and char_length(url) <= 2000)),
  file_name    text check (file_name is null or char_length(file_name) <= 200),
  file_size    integer,
  pdf_data     text,  -- base64-encoded PDF
  is_public    boolean not null default false,
  views        integer not null default 0,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint documents_source check (
    (kind = 'google' and url is not null) or
    (kind = 'pdf' and pdf_data is not null and char_length(pdf_data) <= 7000000 and pdf_data like 'JVBER%')
  )
);

alter table public.documents enable row level security;
revoke all on public.documents from anon, authenticated;

-- ------------------------------------------------------- admin: list ----
create or replace function public.admin_list_documents(p_name text, p_code text)
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
  select coalesce(json_agg(json_build_object(
           'id', d.id, 'slug', d.slug, 'title', d.title, 'description', d.description,
           'kind', d.kind, 'url', d.url, 'file_name', d.file_name, 'file_size', d.file_size,
           'is_public', d.is_public, 'views', d.views, 'created_by', d.created_by,
           'created_at', d.created_at, 'updated_at', d.updated_at
         ) order by d.created_at desc), '[]'::json)
    into v_items
    from public.documents d;
  return json_build_object('ok', true, 'items', v_items);
end;
$$;

-- ------------------------------------------------- admin: create/edit ----
-- p_id null = create. On edit, pass p_pdf_data null to keep the existing PDF.
create or replace function public.admin_save_document(
  p_name text, p_code text, p_id uuid,
  p_slug text, p_title text, p_description text, p_kind text,
  p_url text, p_file_name text, p_file_size integer, p_pdf_data text, p_is_public boolean
) returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
  v_slug  text := lower(trim(coalesce(p_slug, '')));
  v_id    uuid;
begin
  if v_admin is null then
    return json_build_object('ok', false, 'auth', false);
  end if;

  if exists (select 1 from public.documents where slug = v_slug and id is distinct from p_id) then
    return json_build_object('ok', false, 'error', 'That short link is already in use. Please choose another.');
  end if;

  begin
    if p_id is null then
      insert into public.documents (slug, title, description, kind, url, file_name, file_size, pdf_data, is_public, created_by)
      values (v_slug, trim(p_title), nullif(trim(p_description), ''), p_kind,
              case when p_kind = 'google' then trim(p_url) end,
              case when p_kind = 'pdf' then p_file_name end,
              case when p_kind = 'pdf' then p_file_size end,
              case when p_kind = 'pdf' then p_pdf_data end,
              coalesce(p_is_public, false), v_admin)
      returning id into v_id;
    else
      update public.documents set
        slug        = v_slug,
        title       = trim(p_title),
        description = nullif(trim(p_description), ''),
        kind        = p_kind,
        url         = case when p_kind = 'google' then trim(p_url) end,
        file_name   = case when p_kind = 'pdf' then coalesce(p_file_name, file_name) end,
        file_size   = case when p_kind = 'pdf' then coalesce(p_file_size, file_size) end,
        pdf_data    = case when p_kind = 'pdf' then coalesce(p_pdf_data, pdf_data) end,
        is_public   = coalesce(p_is_public, false),
        updated_at  = now()
      where id = p_id
      returning id into v_id;
      if v_id is null then
        return json_build_object('ok', false, 'error', 'That document no longer exists.');
      end if;
    end if;
  exception when check_violation or not_null_violation then
    return json_build_object('ok', false, 'error',
      'Please check the details: short link (letters, numbers, dashes), title (2+ characters), a valid https link or a PDF under 5 MB.');
  end;

  return json_build_object('ok', true, 'id', v_id, 'slug', v_slug);
end;
$$;

-- ------------------------------------------------------ admin: delete ----
create or replace function public.admin_delete_document(p_name text, p_code text, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public._thornhill_check_admin(p_name, p_code) is null then
    return null;
  end if;
  delete from public.documents where id = p_id;
  return found;
end;
$$;

-- -------------------------------------------- public: open by link ----
create or replace function public.get_document(p_slug text)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_doc public.documents;
begin
  update public.documents set views = views + 1
   where slug = lower(trim(coalesce(p_slug, '')))
  returning * into v_doc;
  if v_doc.id is null then
    return null;
  end if;
  return json_build_object(
    'slug', v_doc.slug, 'title', v_doc.title, 'description', v_doc.description,
    'kind', v_doc.kind, 'url', v_doc.url, 'file_name', v_doc.file_name,
    'pdf_data', v_doc.pdf_data, 'created_at', v_doc.created_at, 'updated_at', v_doc.updated_at
  );
end;
$$;

-- ------------------------------------------ public: documents page ----
create or replace function public.list_public_documents()
returns json
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(json_agg(json_build_object(
           'slug', slug, 'title', title, 'description', description,
           'kind', kind, 'updated_at', updated_at
         ) order by updated_at desc), '[]'::json)
    from public.documents
   where is_public;
$$;

grant execute on function public.admin_list_documents(text, text) to anon, authenticated;
grant execute on function public.admin_save_document(text, text, uuid, text, text, text, text, text, text, integer, text, boolean) to anon, authenticated;
grant execute on function public.admin_delete_document(text, text, uuid) to anon, authenticated;
grant execute on function public.get_document(text) to anon, authenticated;
grant execute on function public.list_public_documents() to anon, authenticated;
