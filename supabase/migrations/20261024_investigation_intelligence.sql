-- Persist scenario reviews, recommendation decisions, and method comparisons
-- against the existing investigation owner. Audit events are insert-only to
-- authenticated users; the mutable state is a rebuildable current snapshot.

-- Older deployments may still store investigation ownership as owner_id.
-- Add the column used by this migration's row-level security policies and
-- preserve existing owners when that legacy column is present.
alter table public.investigations
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'investigations'
      and column_name = 'owner_id'
  ) then
    execute 'update public.investigations set user_id = owner_id where user_id is null';
  end if;
end
$$;

create table if not exists public.investigation_intelligence_state (
  investigation_id uuid primary key references public.investigations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null check (coalesce(
    jsonb_typeof(payload) = 'object'
    and payload->>'investigationId' = investigation_id::text
    and jsonb_typeof(payload->'scenarioVersions') = 'array'
    and jsonb_typeof(payload->'recommendations') = 'array'
    and jsonb_typeof(payload->'debateRuns') = 'array'
    and jsonb_typeof(payload->'auditEvents') = 'array',
    false
  )),
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint investigation_intelligence_state_investigation_user_key
    unique (investigation_id, user_id)
);

create table if not exists public.investigation_intelligence_events (
  id uuid primary key,
  investigation_id uuid not null references public.investigations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null check (length(trim(event_type)) > 0),
  description text not null check (length(trim(description)) > 0),
  created_at timestamptz not null default timezone('utc'::text, now())
);

create index if not exists investigation_intelligence_state_user_idx
  on public.investigation_intelligence_state(user_id);

create index if not exists investigation_intelligence_events_investigation_created_idx
  on public.investigation_intelligence_events(investigation_id, created_at);

create index if not exists investigation_intelligence_events_user_created_idx
  on public.investigation_intelligence_events(user_id, created_at);

alter table public.investigation_intelligence_state enable row level security;
alter table public.investigation_intelligence_events enable row level security;

drop policy if exists "Owners manage investigation intelligence state" on public.investigation_intelligence_state;
create policy "Owners manage investigation intelligence state"
  on public.investigation_intelligence_state
  for all
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.investigations i
      where i.id = investigation_id and i.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.investigations i
      where i.id = investigation_id and i.user_id = auth.uid()
    )
  );

drop policy if exists "Owners read investigation intelligence events" on public.investigation_intelligence_events;
create policy "Owners read investigation intelligence events"
  on public.investigation_intelligence_events
  for select
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.investigations i
      where i.id = investigation_id and i.user_id = auth.uid()
    )
  );

drop policy if exists "Owners append investigation intelligence events" on public.investigation_intelligence_events;
create policy "Owners append investigation intelligence events"
  on public.investigation_intelligence_events
  for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.investigations i
      where i.id = investigation_id and i.user_id = auth.uid()
    )
  );

revoke all on public.investigation_intelligence_state from public, anon, authenticated;
revoke all on public.investigation_intelligence_events from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, update on public.investigation_intelligence_state to authenticated;
grant select, insert on public.investigation_intelligence_events to authenticated;

-- Make newly-created public tables visible to PostgREST without waiting for
-- the automatic schema-cache refresh interval.
notify pgrst, 'reload schema';

-- Show the created tables in the SQL Editor instead of leaving the user with
-- the empty result from NOTIFY as the migration's final output.
select
  to_regclass('public.investigation_intelligence_state') as state_table,
  to_regclass('public.investigation_intelligence_events') as events_table;
