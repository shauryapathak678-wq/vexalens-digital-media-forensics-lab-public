-- VexaLens Digital Media Forensics Lab
-- Supabase PostgreSQL Schema Migration
-- Migration: 20261021_reports_repository_retention.sql
-- Module 7: Statutory Report Repository & Case Deletion Retention Policy

-- 1. Modify public.reports table so deletion of an investigation DOES NOT CASCADE delete reports
alter table public.reports
  drop constraint if exists reports_investigation_id_fkey;

alter table public.reports
  alter column investigation_id drop not null;

alter table public.reports
  add constraint reports_investigation_id_fkey
  foreign key (investigation_id)
  references public.investigations(id)
  on delete set null;

-- 2. Add historical metadata, versioning, and retention audit columns to reports table
alter table public.reports
  add column if not exists historical_case_id text,
  add column if not exists historical_case_number text,
  add column if not exists version integer default 1,
  add column if not exists report_format text default 'json+pdf',
  add column if not exists report_snapshot jsonb,
  add column if not exists case_deleted boolean default false,
  add column if not exists case_deleted_at timestamp with time zone,
  add column if not exists evidence_retained boolean default true,
  add column if not exists evidence_retention_policy text default 'statutory_permanent',
  add column if not exists tamper_verified boolean default true,
  add column if not exists audit_signature text,
  add column if not exists updated_at timestamp with time zone default timezone('utc'::text, now()) not null;

-- 3. Create derived artifacts registry table (Module 6)
create table if not exists public.derived_artifacts (
  id uuid default uuid_generate_v4() primary key,
  parent_evidence_id uuid references public.evidence_items(id) on delete cascade not null,
  parent_sha256 text not null,
  derivation_type text not null check (derivation_type in ('keyframe', 'audio_track', 'crop_roi', 'spectral_residual', 'difference_mask')),
  sha256_hash text not null,
  file_size_bytes bigint not null,
  mime_type text not null,
  storage_path text,
  timestamp_sec numeric,
  frame_index integer,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.derived_artifacts enable row level security;
create policy "Users can view own derived artifacts" on public.derived_artifacts for select using (true);
create policy "Users can insert own derived artifacts" on public.derived_artifacts for insert with check (true);
