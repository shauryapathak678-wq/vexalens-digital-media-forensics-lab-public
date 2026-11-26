-- VexaLens Digital Media Forensics Lab
-- Supabase PostgreSQL Schema Migration
-- Migration: 20261015_initial_forensic_schema.sql

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. Profiles Table
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text not null,
  full_name text not null,
  badge_number text,
  agency text,
  role text default 'investigator' check (role in ('investigator', 'lead_analyst', 'administrator')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Investigations Table
create table if not exists public.investigations (
  id uuid default uuid_generate_v4() primary key,
  case_number text unique not null,
  title text not null,
  description text,
  user_id uuid references auth.users(id) on delete cascade not null,
  status text default 'open' check (status in ('open', 'in_progress', 'review', 'closed')),
  priority text default 'medium' check (priority in ('low', 'medium', 'high', 'critical')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 3. Evidence Items Table
create table if not exists public.evidence_items (
  id uuid default uuid_generate_v4() primary key,
  investigation_id uuid references public.investigations(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  file_name text not null,
  file_size bigint not null,
  mime_type text not null,
  media_type text not null check (media_type in ('image', 'video', 'audio')),
  sha256_hash text not null,
  storage_path text not null,
  metadata jsonb default '{}'::jsonb,
  is_original boolean default false,
  verified boolean default true,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 4. Analysis Jobs Table
create table if not exists public.analysis_jobs (
  id uuid default uuid_generate_v4() primary key,
  investigation_id uuid references public.investigations(id) on delete cascade not null,
  evidence_id uuid references public.evidence_items(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  job_type text not null check (job_type in ('image_metadata', 'ela', 'deepfake_ai', 'video_keyframes', 'audio_spectral', 'audio_transcribe')),
  status text default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  parameters jsonb default '{}'::jsonb,
  results jsonb default '{}'::jsonb,
  error_message text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  completed_at timestamp with time zone
);

-- 5. Analysis Findings Table
create table if not exists public.analysis_findings (
  id uuid default uuid_generate_v4() primary key,
  investigation_id uuid references public.investigations(id) on delete cascade not null,
  evidence_id uuid references public.evidence_items(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  title text not null,
  severity text not null check (severity in ('critical', 'warning', 'nominal', 'inconclusive')),
  category text not null check (category in ('metadata', 'compression', 'synthetic_deepfake', 'audio_signal', 'visual_anomaly', 'provenance')),
  observed_evidence text not null,
  plain_english_summary text not null,
  detection_method text not null,
  limitations text,
  detector_version text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 6. Provenance Checks Table
create table if not exists public.provenance_checks (
  id uuid default uuid_generate_v4() primary key,
  investigation_id uuid references public.investigations(id) on delete cascade not null,
  evidence_id uuid references public.evidence_items(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  action_type text not null,
  actor text not null,
  notes text,
  recorded_sha256 text not null,
  verified_match boolean not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 7. Investigation Notes Table
create table if not exists public.investigation_notes (
  id uuid default uuid_generate_v4() primary key,
  investigation_id uuid references public.investigations(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  author_name text not null,
  content text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 8. Activity Logs Table
create table if not exists public.activity_logs (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  investigation_id uuid references public.investigations(id) on delete cascade,
  event_type text not null,
  description text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 9. Reports Table
create table if not exists public.reports (
  id uuid default uuid_generate_v4() primary key,
  investigation_id uuid references public.investigations(id) on delete cascade not null,
  user_id uuid references auth.users(id) on delete cascade not null,
  report_number text unique not null,
  title text not null,
  summary text not null,
  findings_snapshot jsonb not null,
  evidence_inventory jsonb not null,
  pdf_url text,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Row Level Security (RLS) Setup
alter table public.profiles enable row level security;
alter table public.investigations enable row level security;
alter table public.evidence_items enable row level security;
alter table public.analysis_jobs enable row level security;
alter table public.analysis_findings enable row level security;
alter table public.provenance_checks enable row level security;
alter table public.investigation_notes enable row level security;
alter table public.activity_logs enable row level security;
alter table public.reports enable row level security;

-- Ownership RLS Policies
create policy "Users can view own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);

create policy "Users manage own investigations" on public.investigations for all using (auth.uid() = user_id);
create policy "Users manage own evidence" on public.evidence_items for all using (auth.uid() = user_id);
create policy "Users manage own analysis jobs" on public.analysis_jobs for all using (auth.uid() = user_id);
create policy "Users manage own analysis findings" on public.analysis_findings for all using (auth.uid() = user_id);
create policy "Users manage own provenance checks" on public.provenance_checks for all using (auth.uid() = user_id);
create policy "Users manage own investigation notes" on public.investigation_notes for all using (auth.uid() = user_id);
create policy "Users manage own activity logs" on public.activity_logs for all using (auth.uid() = user_id);
create policy "Users manage own reports" on public.reports for all using (auth.uid() = user_id);

-- Storage bucket initialization policy instructions:
-- In Supabase Storage, create a private bucket named 'evidence'.
-- Policies:
-- create policy "Authenticated users can upload evidence" on storage.objects for insert with check (bucket_id = 'evidence' and auth.role() = 'authenticated');
-- create policy "Users can access own evidence" on storage.objects for select using (bucket_id = 'evidence' and auth.uid()::text = (storage.foldername(name))[1]);
