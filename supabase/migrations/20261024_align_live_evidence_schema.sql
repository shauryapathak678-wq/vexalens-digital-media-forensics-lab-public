-- Align the existing evidence_items table with the columns used by the app.
-- Older deployments used filename, file_size_bytes, and owner_id.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'evidence_items' and column_name = 'filename'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'evidence_items' and column_name = 'file_name'
  ) then
    alter table public.evidence_items rename column filename to file_name;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'evidence_items' and column_name = 'file_size_bytes'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'evidence_items' and column_name = 'file_size'
  ) then
    alter table public.evidence_items rename column file_size_bytes to file_size;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'evidence_items' and column_name = 'owner_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'evidence_items' and column_name = 'user_id'
  ) then
    alter table public.evidence_items rename column owner_id to user_id;
  end if;
end
$$;

alter table public.evidence_items
  add column if not exists is_original boolean not null default false,
  add column if not exists verified boolean not null default true,
  add column if not exists metadata jsonb not null default '{}'::jsonb;
