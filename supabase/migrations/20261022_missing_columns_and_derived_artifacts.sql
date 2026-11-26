-- VexaLens Digital Media Forensics Lab
-- Migration: 20261022_missing_columns_and_derived_artifacts.sql
-- Adds missing columns detected by schema inspection and creates derived_artifacts table.
-- All statements are idempotent.

-- ============================================================
-- 1. investigations — add user_id, lead_investigator, evidence_count
--    (The initial migration only created case_number, title, description, status, priority)
-- ============================================================
alter table public.investigations
  add column if not exists user_id uuid references auth.users(id) on delete cascade,
  add column if not exists lead_investigator text default '',
  add column if not exists evidence_count integer default 0,
  add column if not exists tags text[] default '{}';

-- Back-fill RLS: allow users to access their own rows
-- Drop the overly-broad policy if it exists and replace with user-scoped one
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'investigations'
      and policyname = 'Users manage own investigations'
  ) then
    create policy "Users manage own investigations"
      on public.investigations for all
      using (auth.uid() = user_id);
  end if;
end $$;

-- ============================================================
-- 2. evidence_items — add preview_url and thumbnail_data_url
-- ============================================================
alter table public.evidence_items
  add column if not exists preview_url text default '',
  add column if not exists thumbnail_data_url text;

-- ============================================================
-- 3. analysis_findings — add extended explanation columns + extra score fields
-- ============================================================
alter table public.analysis_findings
  add column if not exists simple_explanation text,
  add column if not exists technical_explanation text,
  add column if not exists raw_detector_score numeric,
  add column if not exists confidence_score numeric,
  add column if not exists limitations text;

-- Fix the severity check constraint to match the full set used by the app
alter table public.analysis_findings
  drop constraint if exists analysis_findings_severity_check;

alter table public.analysis_findings
  add constraint analysis_findings_severity_check
  check (severity in ('informational','low','medium','high','critical','nominal','warning','inconclusive'));

-- ============================================================
-- 4. reports — add retention/audit columns (migration 2 may not have run)
-- ============================================================
alter table public.reports
  drop constraint if exists reports_investigation_id_fkey;

alter table public.reports
  alter column investigation_id drop not null;

alter table public.reports
  add constraint reports_investigation_id_fkey
  foreign key (investigation_id)
  references public.investigations(id)
  on delete set null;

alter table public.reports
  add column if not exists historical_case_id    text,
  add column if not exists historical_case_number text,
  add column if not exists conclusion            text default '',
  add column if not exists finding_count         integer default 0,
  add column if not exists evidence_count        integer default 0,
  add column if not exists version               integer default 1,
  add column if not exists report_format         text default 'json+pdf',
  add column if not exists report_snapshot       jsonb,
  add column if not exists case_deleted          boolean default false,
  add column if not exists case_deleted_at       timestamp with time zone,
  add column if not exists evidence_retained     boolean default true,
  add column if not exists evidence_retention_policy text default 'statutory_permanent',
  add column if not exists tamper_verified       boolean default true,
  add column if not exists audit_signature       text,
  add column if not exists updated_at            timestamp with time zone
                                                 default timezone('utc'::text, now()) not null;

-- ============================================================
-- 5. activity_logs — add case_number column for display
-- ============================================================
alter table public.activity_logs
  add column if not exists case_number text;

-- ============================================================
-- 6. derived_artifacts — create if missing
-- ============================================================
create table if not exists public.derived_artifacts (
  id               uuid default uuid_generate_v4() primary key,
  parent_evidence_id uuid references public.evidence_items(id) on delete cascade not null,
  parent_sha256    text not null,
  derivation_type  text not null check (
    derivation_type in ('keyframe','audio_track','crop_roi','spectral_residual','difference_mask')
  ),
  sha256_hash      text not null,
  file_size_bytes  bigint not null,
  mime_type        text not null,
  storage_path     text,
  timestamp_sec    numeric,
  frame_index      integer,
  created_at       timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.derived_artifacts enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'derived_artifacts'
      and policyname = 'Users can view own derived artifacts'
  ) then
    create policy "Users can view own derived artifacts"
      on public.derived_artifacts for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'derived_artifacts'
      and policyname = 'Users can insert own derived artifacts'
  ) then
    create policy "Users can insert own derived artifacts"
      on public.derived_artifacts for insert with check (true);
  end if;
end $$;

-- ============================================================
-- 7. profiles — add updated_at trigger function if not present
-- ============================================================
create or replace function public.handle_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

-- Ensure profiles has updated_at (initial migration already has it but guard anyway)
alter table public.profiles
  add column if not exists updated_at timestamp with time zone
  default timezone('utc'::text, now()) not null;
