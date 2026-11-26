-- Persist the source and result of origin-intelligence hash checks while making
-- provenance records append-only for authenticated application users.

alter table public.provenance_checks
  add column if not exists source_url text,
  add column if not exists source_status text
    check (source_status is null or source_status in ('unverified', 'verified', 'not_applicable'));

drop policy if exists "Users manage own provenance checks" on public.provenance_checks;
drop policy if exists "Users can view own provenance checks" on public.provenance_checks;
drop policy if exists "Users can insert own provenance checks" on public.provenance_checks;

create policy "Users can view own provenance checks"
  on public.provenance_checks
  for select
  using (auth.uid() = user_id);

create policy "Users can insert own provenance checks"
  on public.provenance_checks
  for insert
  with check (auth.uid() = user_id);
