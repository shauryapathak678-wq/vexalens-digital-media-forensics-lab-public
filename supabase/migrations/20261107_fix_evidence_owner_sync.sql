-- Repair evidence ownership so Supabase RLS and the browser query return
-- every evidence row belonging to the signed-in user's investigations.

alter table public.evidence_items
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

update public.evidence_items e
set user_id = i.user_id
from public.investigations i
where e.investigation_id = i.id
  and e.user_id is distinct from i.user_id;

alter table public.evidence_items enable row level security;

do $$
declare existing_policy record;
begin
  for existing_policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'evidence_items'
      and policyname in ('VexaLens users select own evidence', 'Users manage own evidence')
  loop
    execute format('drop policy %I on public.evidence_items', existing_policy.policyname);
  end loop;
end $$;

create policy "VexaLens users select own evidence"
  on public.evidence_items
  for select
  to authenticated
  using (
    auth.uid() = user_id
    or exists (
      select 1
      from public.investigations i
      where i.id = evidence_items.investigation_id
        and i.user_id = auth.uid()
    )
  );

grant select on public.evidence_items to authenticated;
