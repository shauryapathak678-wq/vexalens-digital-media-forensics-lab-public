-- Store user-scoped, append-only origin-analysis results and external-processing consent.
create table if not exists public.origin_landmark_analyses (
  id uuid primary key default uuid_generate_v4(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  processing_status text not null check (processing_status in ('completed', 'partial', 'failed')),
  external_processing_consent boolean not null,
  provider text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists origin_landmark_analyses_evidence_created_idx
  on public.origin_landmark_analyses (evidence_id, created_at desc);

alter table public.origin_landmark_analyses enable row level security;

drop policy if exists "Users can read own origin landmark analyses" on public.origin_landmark_analyses;
create policy "Users can read own origin landmark analyses"
  on public.origin_landmark_analyses
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own origin landmark analyses" on public.origin_landmark_analyses;
create policy "Users can insert own origin landmark analyses"
  on public.origin_landmark_analyses
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.evidence_items evidence
      where evidence.id = origin_landmark_analyses.evidence_id
        and evidence.investigation_id = origin_landmark_analyses.investigation_id
        and evidence.user_id = auth.uid()
        and evidence.sha256_hash = origin_landmark_analyses.file_sha256
    )
  );

grant select, insert on public.origin_landmark_analyses to authenticated;

notify pgrst, 'reload schema';
