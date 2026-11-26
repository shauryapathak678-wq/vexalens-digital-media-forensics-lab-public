-- Repair evidence row ownership policies without allowing cross-user access.
alter table public.evidence_items enable row level security;

do $$
declare
  existing_policy record;
  existing_constraint record;
begin
  for existing_policy in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'evidence_items'
  loop
    execute format('drop policy %I on public.evidence_items', existing_policy.policyname);
  end loop;

  for existing_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.evidence_items'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%media_type%'
  loop
    execute format('alter table public.evidence_items drop constraint %I', existing_constraint.conname);
  end loop;
end
$$;

alter table public.evidence_items
  add constraint evidence_items_media_type_check
  check (media_type in ('image', 'video', 'audio', 'document', 'other'));

create policy "VexaLens users select own evidence"
  on public.evidence_items for select to authenticated
  using (auth.uid() = user_id);

create policy "VexaLens users insert own evidence"
  on public.evidence_items for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.investigations i
      where i.id = evidence_items.investigation_id
        and i.user_id = auth.uid()
    )
  );

create policy "VexaLens users update own evidence"
  on public.evidence_items for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "VexaLens users delete own evidence"
  on public.evidence_items for delete to authenticated
  using (auth.uid() = user_id);

grant select, insert, update, delete on public.evidence_items to authenticated;

-- Allow the formats selected by investigators; project-level upload limits
-- remain enforced by Supabase Storage.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, null, null)
on conflict (id) do update
set public = false,
    file_size_limit = null,
    allowed_mime_types = null;
