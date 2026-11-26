-- Older deployments may have profiles without agency, which the app loads
-- and writes for investigator identity.
alter table public.profiles
  add column if not exists agency text;
