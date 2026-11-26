export interface BackendScreenshotAnalysis extends Record<string, unknown> {
  id: string;
  fileName: string;
  sha256: string;
  analysisTimestamp: string;
}

export interface BackendScreenshotAnalysisJob {
  id: string;
  ownerId: string | null;
  status: 'running' | 'complete' | 'failed';
  startedAt: string;
  result?: BackendScreenshotAnalysis;
  error?: string;
}

const analysisLedger = new Map<string, BackendScreenshotAnalysis>();
const analysisJobs = new Map<string, BackendScreenshotAnalysisJob>();

export function storeScreenshotAnalysis(analysis: BackendScreenshotAnalysis): void {
  analysisLedger.set(analysis.id, analysis);
  if (analysisLedger.size > 10) {
    const oldestKey = analysisLedger.keys().next().value;
    if (oldestKey) analysisLedger.delete(oldestKey);
  }
}

export function getScreenshotAnalysis(id: string): BackendScreenshotAnalysis | null {
  const cached = analysisLedger.get(id);
  if (cached) return cached;
  for (const job of analysisJobs.values()) {
    if (job.result?.id === id) return job.result;
  }
  return null;
}

export function getScreenshotAnalysisHistory(ownerId?: string): BackendScreenshotAnalysis[] {
  const results = ownerId
    ? Array.from(analysisJobs.values())
      .filter((job) => job.ownerId === ownerId && job.result)
      .map((job) => job.result as BackendScreenshotAnalysis)
    : Array.from(analysisLedger.values());
  return results.sort(
    (a, b) => new Date(b.analysisTimestamp).getTime() - new Date(a.analysisTimestamp).getTime()
  );
}

export function createScreenshotAnalysisJob(id: string, ownerId: string | null): void {
  analysisJobs.set(id, {
    id,
    ownerId,
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  if (analysisJobs.size > 10) {
    const oldestKey = analysisJobs.keys().next().value;
    if (oldestKey) analysisJobs.delete(oldestKey);
  }
}

export function completeScreenshotAnalysisJob(id: string, result: BackendScreenshotAnalysis): void {
  const job = analysisJobs.get(id);
  if (job) analysisJobs.set(id, { ...job, status: 'complete', result });
}

export function failScreenshotAnalysisJob(id: string, error: string): void {
  const job = analysisJobs.get(id);
  if (job) analysisJobs.set(id, { ...job, status: 'failed', error });
}

export function getScreenshotAnalysisJob(id: string): BackendScreenshotAnalysisJob | null {
  return analysisJobs.get(id) || null;
}

export function getScreenshotAnalysisJobByResultId(id: string): BackendScreenshotAnalysisJob | null {
  for (const job of analysisJobs.values()) {
    if (job.result?.id === id) return job;
  }
  return null;
}

export function getActiveScreenshotAnalysisJobCount(): number {
  return Array.from(analysisJobs.values()).filter((job) => job.status === 'running').length;
}
