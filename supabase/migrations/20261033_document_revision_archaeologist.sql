create table if not exists public.document_analyses (
  id uuid primary key default uuid_generate_v4(),
  investigation_id uuid references public.investigations(id) on delete set null,
  evidence_id uuid references public.evidence_items(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  analysis_status text not null check (analysis_status in ('parsed', 'partially_parsed', 'rejected')),
  parser_versions jsonb not null default '{}'::jsonb,
  result jsonb not null,
  report_storage_path text,
  report_sha256 text check (report_sha256 is null or report_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);

create index if not exists document_analyses_evidence_created_idx
  on public.document_analyses (evidence_id, created_at desc);
create index if not exists document_analyses_case_created_idx
  on public.document_analyses (investigation_id, created_at desc);

alter table public.document_analyses enable row level security;

drop policy if exists "VexaLens users select own document analyses" on public.document_analyses;
create policy "VexaLens users select own document analyses"
  on public.document_analyses for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "VexaLens users insert own document analyses" on public.document_analyses;
create policy "VexaLens users insert own document analyses"
  on public.document_analyses for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.evidence_items e
      where e.id = evidence_id
        and e.investigation_id = document_analyses.investigation_id
        and e.user_id = auth.uid()
        and e.media_type = 'document'
    )
  );

drop policy if exists "VexaLens users update own document analyses" on public.document_analyses;
create policy "VexaLens users update own document analyses"
  on public.document_analyses for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, insert, update on public.document_analyses to authenticated;

notify pgrst, 'reload schema';
