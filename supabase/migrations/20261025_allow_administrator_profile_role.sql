-- Allow authorized Supabase project owners to assign administrator profiles.
alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('investigator', 'lead_analyst', 'administrator'));
