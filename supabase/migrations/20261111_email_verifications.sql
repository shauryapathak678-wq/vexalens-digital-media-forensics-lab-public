alter table public.evidence_items
  drop constraint if exists evidence_items_media_type_check;

alter table public.evidence_items
  add constraint evidence_items_media_type_check
  check (media_type in ('image', 'video', 'audio', 'document', 'other'));

create table if not exists public.email_verifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  screenshot_evidence_id uuid references public.evidence_items(id) on delete set null,
  eml_evidence_id uuid references public.evidence_items(id) on delete set null,
  report_evidence_id uuid references public.evidence_items(id) on delete set null,
  screenshot_sha256 text,
  eml_sha256 text,
  report_sha256 text,
  result_snapshot jsonb not null,
  investigator_notes text not null default '',
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint email_verifications_screenshot_hash_check
    check (screenshot_sha256 is null or screenshot_sha256 ~ '^[a-f0-9]{64}$'),
  constraint email_verifications_eml_hash_check
    check (eml_sha256 is null or eml_sha256 ~ '^[a-f0-9]{64}$'),
  constraint email_verifications_report_hash_check
    check (report_sha256 is null or report_sha256 ~ '^[a-f0-9]{64}$'),
  constraint email_verifications_has_evidence_check
    check (screenshot_evidence_id is not null or eml_evidence_id is not null)
);

create index if not exists email_verifications_investigation_created_idx
  on public.email_verifications (investigation_id, created_at desc);

alter table public.email_verifications enable row level security;

create policy "Users manage own email verifications"
  on public.email_verifications
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.investigations
      where investigations.id = email_verifications.investigation_id
        and investigations.user_id = auth.uid()
    )
  );
