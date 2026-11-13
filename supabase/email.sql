-- ============================================================================
--  Thornhill Corporation — Emailing Centre
--  Mailboxes (shared like support@ and personal like john@), sent and received
--  email, templates and settings. Sending/receiving itself happens in the
--  "email" Edge Function, which uses Resend.
--  Run AFTER setup.sql. Safe to run again.
--
--  Privacy: everyone can use shared mailboxes. A personal mailbox can only be
--  used, and its email only read, by the admin it belongs to.
-- ============================================================================

-- ------------------------------------------------------------------ tables --
create table if not exists public.mailboxes (
  id            uuid primary key default gen_random_uuid(),
  address       text not null check (address ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' and char_length(address) <= 120),
  display_name  text not null check (char_length(display_name) between 1 and 80),
  kind          text not null check (kind in ('shared', 'personal')),
  owner_name    text,
  signature     text check (signature is null or char_length(signature) <= 2000),
  is_default    boolean not null default false,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists mailboxes_address_unique on public.mailboxes (lower(address));

create table if not exists public.email_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  subject     text check (subject is null or char_length(subject) <= 200),
  body        text not null check (char_length(body) <= 10000),
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.emails (
  id             uuid primary key default gen_random_uuid(),
  mailbox_id     uuid references public.mailboxes(id) on delete set null,
  direction      text not null check (direction in ('in', 'out')),
  thread_id      uuid not null default gen_random_uuid(),
  enquiry_id     uuid references public.enquiries(id) on delete set null,
  from_address   text,
  from_name      text,
  to_addresses   text[] not null default '{}',
  cc_addresses   text[] not null default '{}',
  bcc_addresses  text[] not null default '{}',
  subject        text,
  body_text      text,
  body_html      text,
  status         text not null default 'sent'
                 check (status in ('sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed', 'received')),
  opened_at      timestamptz,
  resend_id      text,
  message_id     text,
  in_reply_to    text,
  attachments    jsonb not null default '[]',
  is_read        boolean not null default true,
  is_starred     boolean not null default false,
  is_archived    boolean not null default false,
  sent_by        text,
  kind           text,          -- e.g. 'ack' for automatic acknowledgements
  error          text,
  created_at     timestamptz not null default now()
);
create index if not exists emails_thread_idx   on public.emails (thread_id);
create index if not exists emails_mailbox_idx  on public.emails (mailbox_id);
create index if not exists emails_enquiry_idx  on public.emails (enquiry_id);
create index if not exists emails_resend_idx   on public.emails (resend_id);
create index if not exists emails_created_idx  on public.emails (created_at desc);

create table if not exists public.email_settings (
  id               integer primary key default 1 check (id = 1),
  domain           text not null default 'thornhillcorporation.co.uk',
  site_url         text not null default 'https://thornhillcorporation.co.uk',
  auto_ack         boolean not null default false,
  ack_mailbox_id   uuid references public.mailboxes(id) on delete set null,
  ack_template_id  uuid references public.email_templates(id) on delete set null,
  updated_at       timestamptz not null default now()
);
insert into public.email_settings (id) values (1) on conflict (id) do nothing;

alter table public.mailboxes       enable row level security;
alter table public.email_templates enable row level security;
alter table public.emails          enable row level security;
alter table public.email_settings  enable row level security;
revoke all on public.mailboxes, public.email_templates, public.emails, public.email_settings from anon, authenticated;

-- A starter template, only if there are none yet
insert into public.email_templates (name, subject, body, created_by)
select 'Enquiry reply', null,
'Hi {{first_name}},

Thank you for contacting Thornhill Corporation about "{{enquiry_subject}}" (reference {{reference}}).



Kind regards,
{{admin_name}}', 'Thornhill'
where not exists (select 1 from public.email_templates);

insert into public.email_templates (name, subject, body, created_by)
select 'Enquiry received (automatic)', 'We''ve received your enquiry [{{reference}}]',
'Hi {{first_name}},

Thanks for getting in touch with Thornhill Corporation. We''ve received your enquiry "{{enquiry_subject}}" and a member of our team will reply as soon as possible.

Your reference number is **{{reference}}**. If you need to add anything, just reply to this email.

Kind regards,
The Thornhill Corporation team', 'Thornhill'
where (select count(*) from public.email_templates) < 2;

-- ------------------------------------------------------------- visibility --
-- Can this admin see/use this mailbox? (null mailbox = unrouted mail, visible to all)
create or replace function public._email_can_use(p_mailbox uuid, p_admin text)
returns boolean language sql stable security definer set search_path = public
as $$
  select p_mailbox is null or exists (
    select 1 from public.mailboxes m
     where m.id = p_mailbox and (m.kind = 'shared' or lower(m.owner_name) = lower(p_admin)));
$$;
revoke all on function public._email_can_use(uuid, text) from public, anon, authenticated;

-- --------------------------------------------------------------- overview --
create or replace function public.admin_email_overview(p_name text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
begin
  if v_admin is null then return json_build_object('ok', false); end if;
  return json_build_object(
    'ok', true,
    'me', v_admin,
    'settings', (select row_to_json(s) from public.email_settings s where id = 1),
    'mailboxes', (select coalesce(json_agg(json_build_object(
        'id', m.id, 'address', m.address, 'display_name', m.display_name, 'kind', m.kind,
        'owner_name', m.owner_name, 'signature', m.signature, 'is_default', m.is_default,
        'can_use', (m.kind = 'shared' or lower(m.owner_name) = lower(v_admin)),
        'unread', (select count(*) from public.emails e where e.mailbox_id = m.id and e.direction = 'in' and not e.is_read and not e.is_archived)
      ) order by (m.kind = 'personal'), m.address), '[]'::json) from public.mailboxes m),
    'templates', (select coalesce(json_agg(json_build_object(
        'id', t.id, 'name', t.name, 'subject', t.subject, 'body', t.body, 'updated_at', t.updated_at
      ) order by t.name), '[]'::json) from public.email_templates t),
    'unread_total', (select count(*) from public.emails e
        where e.direction = 'in' and not e.is_read and not e.is_archived and public._email_can_use(e.mailbox_id, v_admin)),
    'unrouted_unread', (select count(*) from public.emails e
        where e.mailbox_id is null and e.direction = 'in' and not e.is_read and not e.is_archived)
  );
end;
$$;

-- ----------------------------------------------------------- thread list --
-- p_folder: inbox | sent | starred | archive | all ; p_mailbox: a mailbox id, or null for all;
-- p_unrouted: true = only mail that didn't match a mailbox
create or replace function public.admin_list_threads(
  p_name text, p_code text, p_folder text, p_mailbox uuid, p_unrouted boolean, p_search text, p_limit integer, p_offset integer
) returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
  v_q text := nullif(trim(coalesce(p_search, '')), '');
  v_res json;
begin
  if v_admin is null then return json_build_object('ok', false); end if;

  with vis as (
    select e.* from public.emails e
     where public._email_can_use(e.mailbox_id, v_admin)
       and (p_mailbox is null or e.mailbox_id = p_mailbox)
       and (not coalesce(p_unrouted, false) or e.mailbox_id is null)
  ), agg as (
    select thread_id,
           max(created_at) as last_at,
           count(*) as message_count,
           count(*) filter (where direction = 'in' and not is_read) as unread,
           bool_or(is_starred) as starred,
           bool_or(direction = 'in') as has_in,
           bool_or(direction = 'out') as has_out,
           bool_and(is_archived) as archived,
           max(enquiry_id::text) as enquiry_id,
           bool_or(v_q is null or subject ilike '%' || v_q || '%' or body_text ilike '%' || v_q || '%'
                   or from_address ilike '%' || v_q || '%' or coalesce(from_name, '') ilike '%' || v_q || '%'
                   or array_to_string(to_addresses, ' ') ilike '%' || v_q || '%') as matches
      from vis group by thread_id
  ), latest as (
    select distinct on (thread_id) * from vis order by thread_id, created_at desc
  ), picked as (
    select a.*, l.subject, l.from_address, l.from_name, l.to_addresses, l.direction as last_direction,
           l.status as last_status, l.opened_at as last_opened, l.mailbox_id,
           left(regexp_replace(coalesce(l.body_text, ''), '\s+', ' ', 'g'), 160) as snippet
      from agg a join latest l using (thread_id)
     where a.matches
       and case coalesce(p_folder, 'inbox')
             when 'inbox'   then a.has_in and not a.archived
             when 'sent'    then a.has_out
             when 'starred' then a.starred
             when 'archive' then a.archived
             else true end
  )
  select json_build_object(
           'ok', true,
           'total', (select count(*) from picked),
           'items', coalesce((select json_agg(row_to_json(p) order by p.last_at desc) from (
               select p.*, (select q.reference from public.enquiries q where q.id::text = p.enquiry_id) as enquiry_reference
                 from picked p order by last_at desc
                limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))
             ) p), '[]'::json))
    into v_res;
  return v_res;
end;
$$;

-- ---------------------------------------------------------------- thread --
create or replace function public.admin_get_thread(p_name text, p_code text, p_thread uuid)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
  v_msgs json;
  v_enq uuid;
begin
  if v_admin is null then return json_build_object('ok', false); end if;

  update public.emails set is_read = true
   where thread_id = p_thread and not is_read and public._email_can_use(mailbox_id, v_admin);

  select coalesce(json_agg(json_build_object(
           'id', e.id, 'mailbox_id', e.mailbox_id, 'direction', e.direction, 'thread_id', e.thread_id,
           'enquiry_id', e.enquiry_id, 'from_address', e.from_address, 'from_name', e.from_name,
           'to_addresses', e.to_addresses, 'cc_addresses', e.cc_addresses, 'bcc_addresses', e.bcc_addresses,
           'subject', e.subject, 'body_text', e.body_text, 'body_html', e.body_html, 'status', e.status,
           'opened_at', e.opened_at, 'message_id', e.message_id, 'attachments', e.attachments,
           'is_starred', e.is_starred, 'is_archived', e.is_archived, 'sent_by', e.sent_by, 'kind', e.kind,
           'error', e.error, 'created_at', e.created_at
         ) order by e.created_at), '[]'::json),
         max(e.enquiry_id::text)::uuid
    into v_msgs, v_enq
    from public.emails e
   where e.thread_id = p_thread and public._email_can_use(e.mailbox_id, v_admin);

  return json_build_object('ok', true, 'messages', v_msgs,
    'enquiry', (select json_build_object('id', q.id, 'reference', q.reference, 'full_name', q.full_name,
                  'email', q.email, 'subject', q.subject, 'status', q.status)
                  from public.enquiries q where q.id = v_enq));
end;
$$;

-- Messages linked to one enquiry (for the enquiry's email history)
create or replace function public.admin_enquiry_emails(p_name text, p_code text, p_enquiry uuid)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
begin
  if v_admin is null then return json_build_object('ok', false); end if;
  return json_build_object('ok', true, 'items', (
    select coalesce(json_agg(json_build_object(
             'id', e.id, 'thread_id', e.thread_id, 'direction', e.direction, 'from_address', e.from_address,
             'from_name', e.from_name, 'subject', e.subject, 'status', e.status, 'opened_at', e.opened_at,
             'sent_by', e.sent_by, 'kind', e.kind, 'created_at', e.created_at,
             'snippet', left(regexp_replace(coalesce(e.body_text, ''), '\s+', ' ', 'g'), 140)
           ) order by e.created_at), '[]'::json)
      from public.emails e
     where e.enquiry_id = p_enquiry and public._email_can_use(e.mailbox_id, v_admin)));
end;
$$;

-- ------------------------------------------------------- thread actions --
-- p_action: read | unread | star | unstar | archive | unarchive | delete
create or replace function public.admin_thread_action(p_name text, p_code text, p_threads uuid[], p_action text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
  v_n integer;
begin
  if v_admin is null then return json_build_object('ok', false); end if;
  if p_action = 'delete' then
    delete from public.emails where thread_id = any(p_threads) and public._email_can_use(mailbox_id, v_admin);
  elsif p_action in ('read', 'unread') then
    update public.emails set is_read = (p_action = 'read')
     where thread_id = any(p_threads) and direction = 'in' and public._email_can_use(mailbox_id, v_admin);
  elsif p_action in ('star', 'unstar') then
    -- star the latest message only, unstar all
    if p_action = 'star' then
      update public.emails e set is_starred = true
       where e.id in (select distinct on (thread_id) id from public.emails
                       where thread_id = any(p_threads) and public._email_can_use(mailbox_id, v_admin)
                       order by thread_id, created_at desc);
    else
      update public.emails set is_starred = false
       where thread_id = any(p_threads) and public._email_can_use(mailbox_id, v_admin);
    end if;
  elsif p_action in ('archive', 'unarchive') then
    update public.emails set is_archived = (p_action = 'archive')
     where thread_id = any(p_threads) and public._email_can_use(mailbox_id, v_admin);
  else
    return json_build_object('ok', false, 'error', 'Unknown action');
  end if;
  get diagnostics v_n = row_count;
  return json_build_object('ok', true, 'changed', v_n);
end;
$$;

-- -------------------------------------------------------------- mailboxes --
create or replace function public.admin_save_mailbox(
  p_name text, p_code text, p_id uuid, p_address text, p_display_name text, p_kind text, p_signature text, p_is_default boolean
) returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin   text := public._thornhill_check_admin(p_name, p_code);
  v_domain  text := (select lower(domain) from public.email_settings where id = 1);
  v_address text := lower(trim(coalesce(p_address, '')));
  v_old     public.mailboxes;
  v_id      uuid;
begin
  if v_admin is null then return json_build_object('ok', false, 'auth', false); end if;
  if p_kind not in ('shared', 'personal') then return json_build_object('ok', false, 'error', 'Choose shared or personal.'); end if;
  if split_part(v_address, '@', 2) <> v_domain then
    return json_build_object('ok', false, 'error', 'The address must end in @' || v_domain || '.');
  end if;
  if exists (select 1 from public.mailboxes where lower(address) = v_address and id is distinct from p_id) then
    return json_build_object('ok', false, 'error', 'That email address is already set up.');
  end if;

  if p_id is not null then
    select * into v_old from public.mailboxes where id = p_id;
    if v_old.id is null then return json_build_object('ok', false, 'error', 'That mailbox no longer exists.'); end if;
    if v_old.kind = 'personal' and lower(v_old.owner_name) <> lower(v_admin) then
      return json_build_object('ok', false, 'error', 'Only ' || v_old.owner_name || ' can change their personal mailbox.');
    end if;
  end if;

  begin
    if p_id is null then
      insert into public.mailboxes (address, display_name, kind, owner_name, signature, is_default, created_by)
      values (v_address, trim(p_display_name), p_kind, case when p_kind = 'personal' then v_admin end,
              nullif(trim(p_signature), ''), coalesce(p_is_default, false) and p_kind = 'shared', v_admin)
      returning id into v_id;
    else
      update public.mailboxes set
        address = v_address, display_name = trim(p_display_name), kind = p_kind,
        owner_name = case when p_kind = 'personal' then coalesce(v_old.owner_name, v_admin) end,
        signature = nullif(trim(p_signature), ''), is_default = coalesce(p_is_default, false) and p_kind = 'shared',
        updated_at = now()
      where id = p_id returning id into v_id;
    end if;
  exception when check_violation or not_null_violation then
    return json_build_object('ok', false, 'error', 'Please check the email address and display name.');
  end;

  if coalesce(p_is_default, false) and p_kind = 'shared' then
    update public.mailboxes set is_default = false where id <> v_id and is_default;
  end if;
  return json_build_object('ok', true, 'id', v_id);
end;
$$;

create or replace function public.admin_delete_mailbox(p_name text, p_code text, p_id uuid)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
  v_old public.mailboxes;
begin
  if v_admin is null then return json_build_object('ok', false, 'auth', false); end if;
  select * into v_old from public.mailboxes where id = p_id;
  if v_old.id is null then return json_build_object('ok', true); end if;
  if v_old.kind = 'personal' and lower(v_old.owner_name) <> lower(v_admin) then
    return json_build_object('ok', false, 'error', 'Only ' || v_old.owner_name || ' can remove their personal mailbox.');
  end if;
  -- Mail in a deleted personal mailbox is deleted too (it was private); shared mail becomes unrouted
  if v_old.kind = 'personal' then delete from public.emails where mailbox_id = p_id; end if;
  delete from public.mailboxes where id = p_id;
  return json_build_object('ok', true);
end;
$$;

-- -------------------------------------------------------------- templates --
create or replace function public.admin_save_template(p_name text, p_code text, p_id uuid, p_tname text, p_subject text, p_body text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
  v_id uuid;
begin
  if v_admin is null then return json_build_object('ok', false, 'auth', false); end if;
  begin
    if p_id is null then
      insert into public.email_templates (name, subject, body, created_by)
      values (trim(p_tname), nullif(trim(p_subject), ''), p_body, v_admin) returning id into v_id;
    else
      update public.email_templates set name = trim(p_tname), subject = nullif(trim(p_subject), ''), body = p_body, updated_at = now()
       where id = p_id returning id into v_id;
    end if;
  exception when check_violation or not_null_violation then
    return json_build_object('ok', false, 'error', 'Templates need a name and some text.');
  end;
  return json_build_object('ok', v_id is not null, 'id', v_id);
end;
$$;

create or replace function public.admin_delete_template(p_name text, p_code text, p_id uuid)
returns json language plpgsql security definer set search_path = public, extensions
as $$
begin
  if public._thornhill_check_admin(p_name, p_code) is null then return json_build_object('ok', false, 'auth', false); end if;
  delete from public.email_templates where id = p_id;
  return json_build_object('ok', true);
end;
$$;

-- --------------------------------------------------------------- settings --
create or replace function public.admin_save_email_settings(
  p_name text, p_code text, p_domain text, p_site_url text, p_auto_ack boolean, p_ack_mailbox uuid, p_ack_template uuid
) returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_domain text := lower(trim(coalesce(p_domain, '')));
begin
  if public._thornhill_check_admin(p_name, p_code) is null then return json_build_object('ok', false, 'auth', false); end if;
  if v_domain !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then return json_build_object('ok', false, 'error', 'Please enter a domain like thornhillcorporation.co.uk'); end if;
  if coalesce(p_site_url, '') !~* '^https?://' then return json_build_object('ok', false, 'error', 'The website address must start with https://'); end if;
  if coalesce(p_auto_ack, false) and (p_ack_mailbox is null or p_ack_template is null) then
    return json_build_object('ok', false, 'error', 'Choose which mailbox and template the automatic reply uses.');
  end if;
  if p_ack_mailbox is not null and not exists (select 1 from public.mailboxes where id = p_ack_mailbox and kind = 'shared') then
    return json_build_object('ok', false, 'error', 'Automatic replies must come from a shared mailbox, such as support@.');
  end if;
  update public.email_settings set domain = v_domain, site_url = regexp_replace(trim(p_site_url), '/+$', ''),
         auto_ack = coalesce(p_auto_ack, false), ack_mailbox_id = p_ack_mailbox, ack_template_id = p_ack_template, updated_at = now()
   where id = 1;
  return json_build_object('ok', true);
end;
$$;


-- ======================================================================
--  Internal helpers used only by the "email" Edge Function (service role).
--  The public website key cannot call these.
-- ======================================================================

-- Who is sending, from which mailbox, and (optionally) which message they're replying to
create or replace function public._email_send_context(p_name text, p_code text, p_mailbox uuid, p_reply_to uuid)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_admin text := public._thornhill_check_admin(p_name, p_code);
  v_mb public.mailboxes;
  v_prev public.emails;
begin
  if v_admin is null then return json_build_object('ok', false, 'auth', false); end if;
  select * into v_mb from public.mailboxes where id = p_mailbox;
  if v_mb.id is null then return json_build_object('ok', false, 'error', 'Choose a mailbox to send from.'); end if;
  if v_mb.kind = 'personal' and lower(v_mb.owner_name) <> lower(v_admin) then
    return json_build_object('ok', false, 'error', 'You can only send from your own personal address.');
  end if;
  if p_reply_to is not null then
    select * into v_prev from public.emails where id = p_reply_to and public._email_can_use(mailbox_id, v_admin);
  end if;
  return json_build_object('ok', true, 'admin', v_admin, 'mailbox', row_to_json(v_mb),
    'settings', (select row_to_json(s) from public.email_settings s where id = 1),
    'reply', case when v_prev.id is null then null else json_build_object(
        'id', v_prev.id, 'thread_id', v_prev.thread_id, 'enquiry_id', v_prev.enquiry_id,
        'message_id', v_prev.message_id, 'in_reply_to', v_prev.in_reply_to) end);
end;
$$;

-- Record an email that was just sent
create or replace function public._email_record_outbound(p jsonb)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_row public.emails;
  v_enq uuid := nullif(p->>'enquiry_id', '')::uuid;
  v_thread uuid := nullif(p->>'thread_id', '')::uuid;
begin
  -- Replying inside an enquiry's conversation keeps the link to the enquiry
  if v_enq is null and v_thread is not null then
    select enquiry_id into v_enq from public.emails where thread_id = v_thread and enquiry_id is not null limit 1;
  end if;
  -- All email about one enquiry stays in one conversation
  if v_thread is null and v_enq is not null then
    select thread_id into v_thread from public.emails where enquiry_id = v_enq order by created_at desc limit 1;
  end if;
  v_thread := coalesce(v_thread, gen_random_uuid());
  insert into public.emails (mailbox_id, direction, thread_id, enquiry_id, from_address, from_name,
                             to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html,
                             status, resend_id, in_reply_to, attachments, is_read, sent_by, kind, error)
  values ((p->>'mailbox_id')::uuid, 'out', v_thread, v_enq, p->>'from_address', p->>'from_name',
          coalesce(array(select jsonb_array_elements_text(p->'to')), '{}'),
          coalesce(array(select jsonb_array_elements_text(p->'cc')), '{}'),
          coalesce(array(select jsonb_array_elements_text(p->'bcc')), '{}'),
          p->>'subject', p->>'body_text', p->>'body_html', coalesce(p->>'status', 'sent'),
          p->>'resend_id', p->>'in_reply_to', coalesce(p->'attachments', '[]'::jsonb), true,
          p->>'sent_by', p->>'kind', p->>'error')
  returning * into v_row;

  if v_enq is not null and coalesce(p->>'set_enquiry_status', '') in ('new', 'in_progress', 'resolved') then
    update public.enquiries set status = p->>'set_enquiry_status', updated_at = now() where id = v_enq;
  end if;
  return json_build_object('id', v_row.id, 'thread_id', v_row.thread_id, 'enquiry_id', v_row.enquiry_id,
                           'created_at', v_row.created_at, 'status', v_row.status);
end;
$$;

-- File an incoming email: pick the mailbox, find the conversation it belongs to, link the enquiry
create or replace function public._email_record_inbound(p jsonb)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_recipients text[] := array(select lower(x) from jsonb_array_elements_text(
                            coalesce(p->'to', '[]') || coalesce(p->'cc', '[]') || coalesce(p->'received_for', '[]')) x);
  v_refs text[] := array(select x from jsonb_array_elements_text(coalesce(p->'references', '[]')) x where x <> '');
  v_from text := lower(trim(p->>'from_address'));
  v_subject text := coalesce(p->>'subject', '');
  v_norm text := lower(trim(regexp_replace(coalesce(p->>'subject', ''), '^\s*((re|fwd?|aw|sv)\s*:\s*)+', '', 'i')));
  v_ref text := (regexp_match(upper(coalesce(p->>'subject', '')), 'TH-[A-Z0-9]{6}'))[1];
  v_mailbox uuid;
  v_thread uuid;
  v_enq uuid;
  v_row public.emails;
begin
  if exists (select 1 from public.emails where resend_id = p->>'resend_id' and direction = 'in') then
    return json_build_object('duplicate', true);
  end if;

  select id into v_mailbox from public.mailboxes where lower(address) = any(v_recipients)
   order by (kind = 'personal') desc limit 1;

  -- 1) A reply to one of our messages (In-Reply-To / References headers)
  if array_length(v_refs, 1) > 0 then
    select thread_id, enquiry_id into v_thread, v_enq from public.emails e
     where e.message_id = any(v_refs)
        or exists (select 1 from unnest(v_refs) r where e.resend_id is not null and position(e.resend_id in r) > 0)
     order by created_at desc limit 1;
  end if;

  -- 2) The subject mentions an enquiry reference, e.g. [TH-AB12CD]
  if v_thread is null and v_ref is not null then
    select id into v_enq from public.enquiries where reference = v_ref;
    if v_enq is not null then
      select thread_id into v_thread from public.emails where enquiry_id = v_enq order by created_at desc limit 1;
    end if;
  end if;

  -- 3) Same subject, and we've emailed this person in the last 90 days
  if v_thread is null and v_norm <> '' then
    select thread_id, enquiry_id into v_thread, v_enq from public.emails e
     where e.created_at > now() - interval '90 days'
       and lower(trim(regexp_replace(coalesce(e.subject, ''), '^\s*((re|fwd?|aw|sv)\s*:\s*)+', '', 'i'))) = v_norm
       and (lower(e.from_address) = v_from or v_from = any(array(select lower(t) from unnest(e.to_addresses) t)))
     order by created_at desc limit 1;
  end if;

  if v_thread is null then v_thread := gen_random_uuid(); end if;
  if v_enq is null then
    select enquiry_id into v_enq from public.emails where thread_id = v_thread and enquiry_id is not null limit 1;
  end if;
  -- Keep replies in the same mailbox as the rest of the conversation if the address didn't match
  if v_mailbox is null then
    select mailbox_id into v_mailbox from public.emails where thread_id = v_thread and mailbox_id is not null
     order by created_at desc limit 1;
  end if;

  insert into public.emails (mailbox_id, direction, thread_id, enquiry_id, from_address, from_name,
                             to_addresses, cc_addresses, subject, body_text, body_html, status,
                             resend_id, message_id, in_reply_to, attachments, is_read)
  values (v_mailbox, 'in', v_thread, v_enq, v_from, nullif(p->>'from_name', ''),
          coalesce(array(select jsonb_array_elements_text(p->'to')), '{}'),
          coalesce(array(select jsonb_array_elements_text(p->'cc')), '{}'),
          v_subject, p->>'body_text', p->>'body_html', 'received',
          p->>'resend_id', p->>'message_id', v_refs[1], coalesce(p->'attachments', '[]'::jsonb), false)
  returning * into v_row;

  -- A customer replying re-opens a resolved enquiry
  if v_enq is not null then
    update public.enquiries set status = 'in_progress', updated_at = now() where id = v_enq and status = 'resolved';
  end if;
  return json_build_object('id', v_row.id, 'thread_id', v_thread, 'mailbox_id', v_mailbox, 'enquiry_id', v_enq);
end;
$$;

-- Delivery updates from Resend (delivered, bounced, opened...)
create or replace function public._email_record_event(p_resend_id text, p_event text)
returns void language plpgsql security definer set search_path = public, extensions
as $$
begin
  if p_event = 'opened' then
    update public.emails set opened_at = coalesce(opened_at, now()) where resend_id = p_resend_id;
  elsif p_event in ('delivered', 'delivery_delayed', 'bounced', 'complained', 'failed') then
    -- never move a bounced/complained message back to "delivered"
    update public.emails set status = p_event
     where resend_id = p_resend_id and direction = 'out'
       and not (status in ('bounced', 'complained') and p_event in ('delivered', 'delivery_delayed'));
  end if;
end;
$$;

-- Everything needed to send the automatic "we've received your enquiry" email, or null
create or replace function public._email_ack_context(p_reference text)
returns json language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_set public.email_settings;
  v_enq public.enquiries;
begin
  select * into v_set from public.email_settings where id = 1;
  if not v_set.auto_ack or v_set.ack_mailbox_id is null or v_set.ack_template_id is null then return null; end if;
  select * into v_enq from public.enquiries
   where reference = upper(trim(coalesce(p_reference, ''))) and created_at > now() - interval '15 minutes';
  if v_enq.id is null then return null; end if;
  if exists (select 1 from public.emails where enquiry_id = v_enq.id and kind = 'ack') then return null; end if;
  return json_build_object(
    'enquiry', row_to_json(v_enq),
    'settings', row_to_json(v_set),
    'mailbox', (select row_to_json(m) from public.mailboxes m where id = v_set.ack_mailbox_id),
    'template', (select row_to_json(t) from public.email_templates t where id = v_set.ack_template_id));
end;
$$;

revoke all on function public._email_send_context(text, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public._email_record_outbound(jsonb) from public, anon, authenticated;
revoke all on function public._email_record_inbound(jsonb) from public, anon, authenticated;
revoke all on function public._email_record_event(text, text) from public, anon, authenticated;
revoke all on function public._email_ack_context(text) from public, anon, authenticated;
grant execute on function public._email_send_context(text, text, uuid, uuid) to service_role;
grant execute on function public._email_record_outbound(jsonb) to service_role;
grant execute on function public._email_record_inbound(jsonb) to service_role;
grant execute on function public._email_record_event(text, text) to service_role;
grant execute on function public._email_ack_context(text) to service_role;

-- ---------------------------------------------------------------- grants --
grant execute on function public.admin_email_overview(text, text) to anon, authenticated;
grant execute on function public.admin_list_threads(text, text, text, uuid, boolean, text, integer, integer) to anon, authenticated;
grant execute on function public.admin_get_thread(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_enquiry_emails(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_thread_action(text, text, uuid[], text) to anon, authenticated;
grant execute on function public.admin_save_mailbox(text, text, uuid, text, text, text, text, boolean) to anon, authenticated;
grant execute on function public.admin_delete_mailbox(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_save_template(text, text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.admin_delete_template(text, text, uuid) to anon, authenticated;
grant execute on function public.admin_save_email_settings(text, text, text, text, boolean, uuid, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
