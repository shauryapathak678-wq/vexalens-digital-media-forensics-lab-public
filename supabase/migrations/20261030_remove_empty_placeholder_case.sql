-- Remove only the empty default case generated automatically by older app builds.
-- Keep it if evidence is attached so existing records are not orphaned or deleted.
delete from public.investigations i
where i.case_number = 'VL-2026-001'
  and i.title = 'Primary Forensic Investigation'
  and not exists (
    select 1
    from public.evidence_items e
    where e.investigation_id = i.id
  );
