-- Thornhill Emailing Centre — part 1 of 3. Run parts 1, 2 and 3 in order, each in its own new query.

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

