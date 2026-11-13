-- Thornhill Emailing Centre — part 2 of 3. Run parts 1, 2 and 3 in order, each in its own new query.

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


