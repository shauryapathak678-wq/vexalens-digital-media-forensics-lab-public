-- Keep legacy investigations.owner_id aligned with the app's user_id column.
-- Some deployed schemas still require owner_id on insert.
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
    update public.investigations
    set user_id = owner_id
    where user_id is null;

    execute $function$
      create or replace function public.sync_investigation_owner_id()
      returns trigger
      language plpgsql
      set search_path = public
      as $body$
      begin
        if new.user_id is not null then
          new.owner_id := new.user_id;
        end if;
        return new;
      end
      $body$
    $function$;

    drop trigger if exists sync_investigation_owner_id
      on public.investigations;
    create trigger sync_investigation_owner_id
      before insert or update of user_id
      on public.investigations
      for each row
      execute function public.sync_investigation_owner_id();
  end if;
end
$$;
