-- Thornhill Emailing Centre — part 3 of 3. Run parts 1, 2 and 3 in order, each in its own new query.

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
