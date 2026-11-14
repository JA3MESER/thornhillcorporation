-- ============================================================================
--  Thornhill Corporation — Legal Enquiry Form
--  Run this ONCE in Supabase → SQL Editor (after setup.sql and email.sql).
--  Safe to run again.
--
--  Legal enquiries are stored with support enquiries (so replies, the Emailing
--  Centre, statuses and notes all work the same way), marked kind = 'legal'.
--  The extra form answers are kept in the "legal" column.
-- ============================================================================

alter table public.enquiries add column if not exists kind  text not null default 'support';
alter table public.enquiries add column if not exists legal jsonb;

do $$ begin
  alter table public.enquiries add constraint enquiries_kind_check check (kind in ('support', 'legal'));
exception when duplicate_object then null; end $$;

-- ------------------------------------------------------ public: submit ----
create or replace function public.submit_legal_enquiry(
  p_full_name text, p_email text, p_subject text, p_details text,
  p_priority text, p_jurisdiction text, p_proceed text, p_notes text
) returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ref   text;
  v_chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i int;
begin
  if p_priority not in ('Low', 'Medium', 'High', 'Urgent') then
    raise exception 'Please choose a priority.';
  end if;
  if p_jurisdiction not in ('England', 'Wales', 'Scotland', 'Ireland') then
    raise exception 'Please choose where you live.';
  end if;
  if p_proceed not in ('Yes', 'No') then
    raise exception 'Please answer whether you wish to proceed.';
  end if;
  if char_length(coalesce(p_notes, '')) > 5000 then
    raise exception 'Additional information is too long.';
  end if;

  loop
    v_ref := 'TH-';
    for i in 1..6 loop
      v_ref := v_ref || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.enquiries where reference = v_ref);
  end loop;

  insert into public.enquiries (reference, kind, full_name, email, category, subject, message, legal)
  values (v_ref, 'legal', trim(p_full_name), lower(trim(p_email)), 'Legal enquiry',
          trim(p_subject), trim(p_details),
          jsonb_build_object('priority', p_priority, 'jurisdiction', p_jurisdiction,
                             'proceed', p_proceed, 'notes', nullif(trim(coalesce(p_notes, '')), '')));
  return v_ref;
end;
$$;

grant execute on function public.submit_legal_enquiry(text, text, text, text, text, text, text, text) to anon, authenticated;

-- A starter reply template for legal enquiries (the Legal Cases "Reply" button uses it)
insert into public.email_templates (name, subject, body, created_by)
select 'Legal enquiry reply', null,
'Dear {{name}},

Thank you for submitting a legal enquiry to Thornhill Corporation regarding "{{enquiry_subject}}". Your case reference is {{reference}}; please quote it in any future correspondence.



Yours sincerely,
{{admin_name}}
Legal Team, Thornhill Corporation', 'Thornhill'
where exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'email_templates')
  and not exists (select 1 from public.email_templates where name = 'Legal enquiry reply');
