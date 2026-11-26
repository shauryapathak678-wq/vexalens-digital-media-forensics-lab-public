-- Store user-scoped reverse-search results and explicit provider-consent audits.
create table if not exists public.reverse_media_searches (
  id uuid primary key default uuid_generate_v4(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  external_processing_consent boolean not null,
  provider_status text not null check (
    provider_status in (
      'not_requested',
      'not_configured',
      'completed',
      'partial',
      'no_match',
      'authentication_failed',
      'quota_exceeded',
      'network_error',
      'provider_error'
    )
  ),
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists reverse_media_searches_evidence_created_idx
  on public.reverse_media_searches (evidence_id, created_at desc);
create index if not exists reverse_media_searches_user_created_idx
  on public.reverse_media_searches (user_id, created_at desc);

alter table public.reverse_media_searches enable row level security;

drop policy if exists "Users can read own reverse media searches" on public.reverse_media_searches;
create policy "Users can read own reverse media searches"
  on public.reverse_media_searches
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own reverse media searches" on public.reverse_media_searches;
create policy "Users can insert own reverse media searches"
  on public.reverse_media_searches
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.evidence_items evidence
      where evidence.id = reverse_media_searches.evidence_id
        and evidence.investigation_id = reverse_media_searches.investigation_id
        and evidence.user_id = auth.uid()
        and evidence.sha256_hash = reverse_media_searches.file_sha256
    )
  );

grant select, insert on public.reverse_media_searches to authenticated;

notify pgrst, 'reload schema';
