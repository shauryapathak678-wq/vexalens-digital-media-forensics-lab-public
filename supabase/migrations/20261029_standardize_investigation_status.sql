-- Standardize investigations.status to the values used by the application.
do $$
declare
  status_constraint record;
begin
  for status_constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.investigations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format(
      'alter table public.investigations drop constraint %I',
      status_constraint.conname
    );
  end loop;
end
$$;

update public.investigations
set status = case lower(trim(status))
  when 'open' then 'open'
  when 'new' then 'open'
  when 'pending' then 'open'
  when 'in_progress' then 'in_progress'
  when 'in progress' then 'in_progress'
  when 'active' then 'in_progress'
  when 'review' then 'review'
  when 'completed' then 'review'
  when 'analysis_complete' then 'review'
  when 'closed' then 'closed'
  when 'archived' then 'closed'
  else 'open'
end
where status is null
   or status not in ('open', 'in_progress', 'review', 'closed');

alter table public.investigations
  alter column status set default 'open',
  alter column status set not null,
  add constraint investigations_status_check
    check (status in ('open', 'in_progress', 'review', 'closed'));
