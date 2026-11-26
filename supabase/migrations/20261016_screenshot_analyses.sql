create table if not exists public.screenshot_analyses (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  investigation_id uuid references public.investigations(id) on delete set null,
  evidence_id uuid references public.evidence_items(id) on delete set null,
  file_name text not null,
  sha256_hash text not null,
  detector_version text not null,
  parameters jsonb not null default '{}'::jsonb,
  result_snapshot jsonb not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists screenshot_analyses_user_case_created_idx
  on public.screenshot_analyses (user_id, investigation_id, created_at desc);

alter table public.screenshot_analyses enable row level security;

create policy "Users view own screenshot analyses"
  on public.screenshot_analyses
  for select
  using (auth.uid() = user_id);

create policy "Users insert own screenshot analyses"
  on public.screenshot_analyses
  for insert
  with check (auth.uid() = user_id);
