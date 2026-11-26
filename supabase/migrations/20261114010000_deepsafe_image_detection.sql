alter table public.ai_image_detection_runs
  add column if not exists model_outputs jsonb not null default '{}'::jsonb,
  add column if not exists ensemble_method text,
  add column if not exists fake_votes integer,
  add column if not exists total_votes integer,
  add column if not exists duration_ms integer,
  add column if not exists file_size bigint,
  add column if not exists error_detail text;

alter table public.ai_image_detection_runs
  drop constraint if exists ai_image_detection_runs_assessment_check;

alter table public.ai_image_detection_runs
  add constraint ai_image_detection_runs_assessment_check
  check (
    assessment in (
      'possible_ai_generated',
      'camera_consistent',
      'possible_ai_assisted_editing',
      'non_flagged_consistent',
      'inconclusive',
      'analysis_failed'
    )
  );

alter table public.ai_image_detection_runs
  drop constraint if exists ai_image_detection_runs_processing_status_check;

alter table public.ai_image_detection_runs
  add constraint ai_image_detection_runs_processing_status_check
  check (processing_status in ('completed', 'partial', 'failed'));
