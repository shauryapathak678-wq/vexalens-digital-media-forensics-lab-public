import { ProcessingJob, JobLifecycleStatus } from '@/types/forensics';

const JOBS_STORAGE_KEY = 'vexalens_processing_jobs';

const INITIAL_JOBS: ProcessingJob[] = [
  {
    id: 'JOB-2026-9041',
    evidenceId: 'ev_portrait_01',
    caseNumber: 'VEX-2026-0041',
    type: 'ai_origin_detection',
    status: 'completed',
    progressPercent: 100,
    stage: 'Analysis Finalized',
    createdAt: new Date(Date.now() - 4800000).toISOString(),
    startedAt: new Date(Date.now() - 4798000).toISOString(),
    completedAt: new Date(Date.now() - 4785000).toISOString(),
    durationMs: 13000,
    retryCount: 0,
    resultSummary: 'Spectral-PRNU analysis completed: Natural sensor shot noise and 1/f^alpha frequency decay verified.',
  },
  {
    id: 'JOB-2026-9042',
    evidenceId: 'ev_deepfake_01',
    caseNumber: 'VEX-2026-0041',
    type: 'video_deepfake_analysis',
    status: 'completed',
    progressPercent: 100,
    stage: 'Analysis Finalized',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    startedAt: new Date(Date.now() - 3597000).toISOString(),
    completedAt: new Date(Date.now() - 3572000).toISOString(),
    durationMs: 25000,
    retryCount: 0,
    resultSummary: 'Temporal keyframe analysis completed: High-frequency checkerboard harmonics detected.',
  },
  {
    id: 'JOB-2026-9043',
    evidenceId: 'ev_document_01',
    caseNumber: 'VEX-2026-0078',
    type: 'signature_comparison',
    status: 'completed',
    progressPercent: 100,
    stage: 'Analysis Finalized',
    createdAt: new Date(Date.now() - 1800000).toISOString(),
    startedAt: new Date(Date.now() - 1798000).toISOString(),
    completedAt: new Date(Date.now() - 1790000).toISOString(),
    durationMs: 8000,
    retryCount: 0,
    resultSummary: 'Biometric contour similarity: 78.4% overlap with reference exemplar.',
  },
];

export function getStoredJobs(): ProcessingJob[] {
  try {
    const raw = localStorage.getItem(JOBS_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(INITIAL_JOBS));
      return INITIAL_JOBS;
    }
    return JSON.parse(raw);
  } catch {
    return INITIAL_JOBS;
  }
}

export function saveStoredJobs(jobs: ProcessingJob[]): void {
  try {
    localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(jobs));
  } catch (err) {
    console.error('Failed to save processing jobs to local storage:', err);
  }
}

export function createJob(
  type: ProcessingJob['type'],
  evidenceId?: string,
  caseNumber?: string
): ProcessingJob {
  const jobs = getStoredJobs();
  const id = `JOB-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
  const now = new Date().toISOString();

  const newJob: ProcessingJob = {
    id,
    evidenceId,
    caseNumber: caseNumber || 'UNASSIGNED',
    type,
    status: 'queued',
    progressPercent: 0,
    stage: 'Job Queued in Local Worker Pool',
    createdAt: now,
    retryCount: 0,
  };

  jobs.unshift(newJob);
  saveStoredJobs(jobs);
  return newJob;
}

export function updateJobStatus(
  id: string,
  updates: Partial<ProcessingJob>
): ProcessingJob | undefined {
  const jobs = getStoredJobs();
  const index = jobs.findIndex((j) => j.id === id);
  if (index === -1) return undefined;

  const current = jobs[index];
  const updated: ProcessingJob = {
    ...current,
    ...updates,
  };

  if (updates.status === 'running' && !current.startedAt) {
    updated.startedAt = new Date().toISOString();
  }

  if ((updates.status === 'completed' || updates.status === 'failed' || updates.status === 'cancelled') && !current.completedAt) {
    updated.completedAt = new Date().toISOString();
    if (updated.startedAt) {
      updated.durationMs = Math.max(100, new Date(updated.completedAt).getTime() - new Date(updated.startedAt).getTime());
    }
  }

  jobs[index] = updated;
  saveStoredJobs(jobs);
  return updated;
}

export function cancelJob(id: string): ProcessingJob | undefined {
  return updateJobStatus(id, {
    status: 'cancelled',
    stage: 'Job Cancelled by Examiner',
    error: 'Execution cancelled before completion',
  });
}

export function retryJob(id: string): ProcessingJob | undefined {
  const jobs = getStoredJobs();
  const index = jobs.findIndex((j) => j.id === id);
  if (index === -1) return undefined;

  const current = jobs[index];
  const updated: ProcessingJob = {
    ...current,
    status: 'queued',
    stage: 'Re-queued for execution',
    progressPercent: 0,
    retryCount: (current.retryCount || 0) + 1,
    error: undefined,
    startedAt: undefined,
    completedAt: undefined,
    durationMs: undefined,
  };

  jobs[index] = updated;
  saveStoredJobs(jobs);
  return updated;
}

export function deleteJob(id: string): void {
  const jobs = getStoredJobs().filter((j) => j.id !== id);
  saveStoredJobs(jobs);
}

export interface ProcessingJobStats {
  total: number;
  active: number;
  queued: number;
  completed: number;
  failed: number;
  cancelled: number;
  avgDurationMs: number;
  lastSuccessfulTime?: string;
  recentErrors: Array<{ id: string; error: string; time: string }>;
}

export function getJobStats(): ProcessingJobStats {
  const jobs = getStoredJobs();
  let completedCount = 0;
  let totalDurationMs = 0;
  let lastSuccessfulTime: string | undefined;
  const recentErrors: Array<{ id: string; error: string; time: string }> = [];

  const counts: Record<JobLifecycleStatus, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };

  for (const j of jobs) {
    counts[j.status] = (counts[j.status] || 0) + 1;
    if (j.status === 'completed') {
      completedCount++;
      if (j.durationMs) totalDurationMs += j.durationMs;
      if (!lastSuccessfulTime || (j.completedAt && j.completedAt > lastSuccessfulTime)) {
        lastSuccessfulTime = j.completedAt;
      }
    } else if (j.status === 'failed' && j.error) {
      recentErrors.push({
        id: j.id,
        error: j.error,
        time: j.completedAt || j.createdAt,
      });
    }
  }

  return {
    total: jobs.length,
    active: counts.running,
    queued: counts.queued,
    completed: counts.completed,
    failed: counts.failed,
    cancelled: counts.cancelled,
    avgDurationMs: completedCount > 0 ? Math.round(totalDurationMs / completedCount) : 0,
    lastSuccessfulTime,
    recentErrors: recentErrors.slice(0, 5),
  };
}
