-- Create the VexaLens private evidence bucket if it does not already exist.
-- Existing bucket configuration is intentionally left unchanged.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'evidence',
  'evidence',
  false,
  104857600,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'audio/mpeg',
    'audio/mp3',
    'audio/wav',
    'audio/ogg',
    'audio/webm'
  ]
)
on conflict (id) do nothing;

-- Store each user's objects under <auth.uid()>/..., and deny access to anonymous users.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'VexaLens users read own evidence'
  ) then
    create policy "VexaLens users read own evidence"
      on storage.objects for select to authenticated
      using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'VexaLens users upload own evidence'
  ) then
    create policy "VexaLens users upload own evidence"
      on storage.objects for insert to authenticated
      with check (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'VexaLens users update own evidence'
  ) then
    create policy "VexaLens users update own evidence"
      on storage.objects for update to authenticated
      using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'VexaLens users delete own evidence'
  ) then
    create policy "VexaLens users delete own evidence"
      on storage.objects for delete to authenticated
      using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end
$$;
