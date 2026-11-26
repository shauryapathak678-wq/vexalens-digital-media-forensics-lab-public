alter table public.document_analyses
  add column if not exists truthscan_pdf_job_id text,
  add column if not exists truthscan_pdf_status text,
  add column if not exists truthscan_pdf_model text,
  add column if not exists truthscan_pdf_modules text[] not null default '{}',
  add column if not exists truthscan_pdf_result jsonb,
  add column if not exists truthscan_pdf_credits_deducted integer,
  add column if not exists truthscan_pdf_error text;

create unique index if not exists document_analyses_truthscan_pdf_job_idx
  on public.document_analyses (truthscan_pdf_job_id)
  where truthscan_pdf_job_id is not null;

notify pgrst, 'reload schema';
