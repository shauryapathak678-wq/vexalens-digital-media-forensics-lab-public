create table if not exists public.ai_image_detection_runs (
  id uuid primary key default uuid_generate_v4(),
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  evidence_id uuid not null references public.evidence_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null,
  image_sha256 text not null check (image_sha256 ~ '^[a-fA-F0-9]{64}$'),
  mime_type text not null,
  image_width integer not null check (image_width > 0),
  image_height integer not null check (image_height > 0),
  model_id text not null,
  model_name text not null,
  model_version text not null,
  provider text not null,
  assessment text not null check (
    assessment in (
      'possible_ai_generated',
      'camera_consistent',
      'possible_ai_assisted_editing',
      'inconclusive'
    )
  ),
  observations jsonb not null default '[]'::jsonb,
  request_usage jsonb not null default '{}'::jsonb,
  processing_status text not null check (processing_status = 'completed'),
  limitations jsonb not null default '[]'::jsonb,
  analyzed_at timestamptz not null,
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists ai_image_detection_runs_case_evidence_idx
  on public.ai_image_detection_runs (investigation_id, evidence_id, analyzed_at desc);

alter table public.ai_image_detection_runs enable row level security;

create policy "Users manage own AI image detection runs"
  on public.ai_image_detection_runs
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
