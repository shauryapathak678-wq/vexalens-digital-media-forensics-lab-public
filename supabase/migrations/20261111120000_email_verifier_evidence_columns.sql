-- Keep the evidence table aligned with the columns written by the sync layer.
alter table public.evidence_items
  add column if not exists item_tag uuid not null default gen_random_uuid(),
  add column if not exists md5_hash text;

grant select, insert, update, delete on public.email_verifications to authenticated;
