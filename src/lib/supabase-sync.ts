/**
 * VexaLens — Supabase sync layer.
 * All Supabase CRUD operations are here. localStorage stays as the local cache;
 * this module fetches/pushes to the remote DB when the user is authenticated.
 *
 * Column mapping (DB snake_case → app camelCase):
 *   investigations: case_number → caseNumber, user_id → userId, etc.
 *   evidence_items: investigation_id → investigationId, sha256_hash → sha256Hash, etc.
 *   analysis_findings: investigation_id → investigationId, observed_evidence → observedEvidence, etc.
 *   reports: report_number → reportNumber, report_snapshot → reportSnapshot, etc.
 */
import * as tus from 'tus-js-client';
import { getSupabaseClient, getAuthUser, getSupabaseConfig } from './supabase';
import type {
  Investigation,
  EvidenceItem,
  EvidenceMetadata,
  AnalysisFinding,
  ActivityLog,
  PermanentReportRecord,
  ProvenanceEvent,
} from '@/types/forensics';
import type { DocumentAnalysisResult } from '@/types/documentForensics';
import type { ScreenshotAnalysisResult } from '@/types/screenshotForensics';
import type { EmailVerificationRecord, EmailVerifierResult } from '@/types/emailVerifier';
import type { PuterVisualAssessmentResult } from '@/lib/forensics/puterAiDetector';
import type { DeepSafeImageAnalysis } from '@/lib/forensics/deepsafeImageDetector';

const pendingInvestigationCreates = new Map<string, Promise<Investigation>>();
const RESUMABLE_VIDEO_UPLOAD_THRESHOLD_BYTES = 6 * 1024 * 1024;
const RESUMABLE_VIDEO_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

const LOCAL_EMAIL_VERIFICATIONS_KEY = 'vexalens_local_email_verifications';

function getEvidenceUploadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/\b413\b|maximum size exceeded|payload too large/i.test(message)) {
    return 'Supabase rejected this file because it exceeds the project or bucket upload-size limit. Resumable uploads cannot bypass that limit. Check Storage Settings and the evidence bucket limits.';
  }
  return message || 'Storage request failed.';
}

export function getLocalEmailVerifications(): EmailVerificationRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_EMAIL_VERIFICATIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveLocalEmailVerification(record: EmailVerificationRecord): void {
  try {
    const existing = getLocalEmailVerifications().filter((r) => r.id !== record.id);
    localStorage.setItem(LOCAL_EMAIL_VERIFICATIONS_KEY, JSON.stringify([record, ...existing]));
  } catch (err) {
    console.warn('[SupabaseSync] Could not persist email verification to localStorage:', err);
  }
}

export function updateLocalEmailVerification(
  id: string,
  updates: { investigatorNotes?: string; reportEvidenceId?: string; reportSha256?: string }
): void {
  try {
    const list = getLocalEmailVerifications();
    const idx = list.findIndex((item) => item.id === id);
    if (idx !== -1) {
      list[idx] = {
        ...list[idx],
        investigatorNotes: updates.investigatorNotes !== undefined ? updates.investigatorNotes : list[idx].investigatorNotes,
        reportEvidenceId: updates.reportEvidenceId !== undefined ? updates.reportEvidenceId : list[idx].reportEvidenceId,
        reportSha256: updates.reportSha256 !== undefined ? updates.reportSha256 : list[idx].reportSha256,
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(LOCAL_EMAIL_VERIFICATIONS_KEY, JSON.stringify(list));
    }
  } catch (err) {
    console.warn('[SupabaseSync] Could not update email verification in localStorage:', err);
  }
}

function isEmailVerifierSchemaMissing(message: string): boolean {
  return /email_verifications|evidence_items|item_tag|md5_hash|schema cache|could not find the table|PGRST204|PGRST205|42P01|42703/i.test(message);
}

export async function syncSaveEmailVerification(
  investigation: Investigation,
  screenshotEvidenceId: string | null,
  emlEvidenceId: string | null,
  result: EmailVerifierResult
): Promise<EmailVerificationRecord> {
  const fallbackRecord: EmailVerificationRecord = {
    id: crypto.randomUUID(),
    investigationId: investigation.id,
    screenshotEvidenceId,
    emlEvidenceId,
    screenshotSha256: result.screenshot.sha256,
    emlSha256: result.email?.sha256 || null,
    result,
    investigatorNotes: '',
    reportEvidenceId: null,
    reportSha256: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) {
    saveLocalEmailVerification(fallbackRecord);
    return fallbackRecord;
  }

  let savedInvestigationId = investigation.id;
  try {
    const savedInvestigation = await syncEnsureInvestigation(investigation);
    savedInvestigationId = savedInvestigation.id;
  } catch {}

  try {
    const { data, error } = await client
      .from('email_verifications')
      .insert({
        user_id: user.id,
        investigation_id: savedInvestigationId,
        screenshot_evidence_id: screenshotEvidenceId,
        eml_evidence_id: emlEvidenceId,
        screenshot_sha256: result.screenshot.sha256,
        eml_sha256: result.email?.sha256 || null,
        result_snapshot: result,
      })
      .select('id, investigation_id, screenshot_evidence_id, eml_evidence_id, screenshot_sha256, eml_sha256, result_snapshot, investigator_notes, report_evidence_id, report_sha256, created_at, updated_at')
      .single();

    if (error || !data) {
      if (isEmailVerifierSchemaMissing(error?.message || '')) {
        console.warn('[EmailVerifier] Supabase email_verifications table not found; saved to local workspace storage.');
        saveLocalEmailVerification(fallbackRecord);
        return fallbackRecord;
      }
      throw new Error(`Could not save email verification: ${error?.message || 'no database record returned.'}`);
    }
    const saved = dbToEmailVerification(data);
    saveLocalEmailVerification(saved);
    return saved;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isEmailVerifierSchemaMissing(msg)) {
      console.warn('[EmailVerifier] Schema missing, falling back to local workspace storage.');
      saveLocalEmailVerification(fallbackRecord);
      return fallbackRecord;
    }
    throw err;
  }
}

export async function syncFetchEmailVerifications(investigation: Investigation): Promise<EmailVerificationRecord[]> {
  const localList = getLocalEmailVerifications().filter((r) => !r.investigationId || r.investigationId === investigation.id);

  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) {
    return localList;
  }

  let savedInvestigationId = investigation.id;
  try {
    const savedInvestigation = await syncEnsureInvestigation(investigation);
    savedInvestigationId = savedInvestigation.id;
  } catch {}

  try {
    const { data, error } = await client
      .from('email_verifications')
      .select('id, investigation_id, screenshot_evidence_id, eml_evidence_id, screenshot_sha256, eml_sha256, result_snapshot, investigator_notes, report_evidence_id, report_sha256, created_at, updated_at')
      .eq('user_id', user.id)
      .eq('investigation_id', savedInvestigationId)
      .order('created_at', { ascending: false });

    if (error) {
      if (isEmailVerifierSchemaMissing(error.message)) {
        return localList;
      }
      console.warn('[EmailVerifier] Remote load failed, using local verifications:', error.message);
      return localList;
    }
    const remoteList = (data || []).map(dbToEmailVerification);
    const remoteIds = new Set(remoteList.map((r) => r.id));
    return [...remoteList, ...localList.filter((r) => !remoteIds.has(r.id))];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isEmailVerifierSchemaMissing(msg)) {
      return localList;
    }
    console.warn('[EmailVerifier] Remote load failed, using local verifications:', msg);
    return localList;
  }
}

function describeEmailVerifierSchemaError(error: { code?: string; message: string }, action: string): string {
  const message = error.message || 'Unknown Supabase error.';
  if (['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code || '')
    || (message.includes('email_verifications') && /does not exist|schema cache|could not find/i.test(message))) {
    return `Database migration not applied: Supabase could not ${action} because the email-verification or evidence schema is missing. Run "npx supabase db push" from the project root, then retry. Details: ${message}`;
  }
  return `Could not ${action}: ${message}`;
}

export async function syncCheckEmailVerifierSchema(): Promise<{ schemaReady: boolean; error?: string }> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) {
    return { schemaReady: false, error: 'Sign in to Supabase to enable cloud synchronization. Local workspace storage is active.' };
  }

  try {
    const [verificationCheck, evidenceCheck] = await Promise.all([
      client.from('email_verifications').select('id').limit(0),
      client.from('evidence_items').select('id').limit(0),
    ]);
    if (verificationCheck.error) {
      return {
        schemaReady: false,
        error: describeEmailVerifierSchemaError(verificationCheck.error, 'check the email-verification schema'),
      };
    }
    if (evidenceCheck.error) {
      return {
        schemaReady: false,
        error: describeEmailVerifierSchemaError(evidenceCheck.error, 'check the evidence upload schema'),
      };
    }
    return { schemaReady: true };
  } catch (err: unknown) {
    return {
      schemaReady: false,
      error: err instanceof Error ? err.message : 'Could not check Supabase schema.',
    };
  }
}

export async function syncUpdateEmailVerification(
  id: string,
  updates: { investigatorNotes?: string; reportEvidenceId?: string; reportSha256?: string }
): Promise<void> {
  updateLocalEmailVerification(id, updates);

  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return;

  const row: Record<string, string> = {};
  if (updates.investigatorNotes !== undefined) row.investigator_notes = updates.investigatorNotes;
  if (updates.reportEvidenceId !== undefined) row.report_evidence_id = updates.reportEvidenceId;
  if (updates.reportSha256 !== undefined) row.report_sha256 = updates.reportSha256;
  if (Object.keys(row).length === 0) return;
  row.updated_at = new Date().toISOString();

  try {
    const { error } = await client
      .from('email_verifications')
      .update(row)
      .eq('id', id)
      .eq('user_id', user.id);
    if (error && !isEmailVerifierSchemaMissing(error.message)) {
      console.warn('[EmailVerifier] Supabase update warning:', error.message);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!isEmailVerifierSchemaMissing(msg)) {
      console.warn('[EmailVerifier] Supabase update error:', msg);
    }
  }
}

function dbToEmailVerification(row: any): EmailVerificationRecord {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    screenshotEvidenceId: row.screenshot_evidence_id,
    emlEvidenceId: row.eml_evidence_id,
    screenshotSha256: row.screenshot_sha256,
    emlSha256: row.eml_sha256,
    result: row.result_snapshot as EmailVerifierResult,
    investigatorNotes: row.investigator_notes || '',
    reportEvidenceId: row.report_evidence_id,
    reportSha256: row.report_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Investigations
// ---------------------------------------------------------------------------

function normalizeInvestigationStatus(status: unknown): Investigation['status'] {
  switch (String(status || '').trim().toLowerCase()) {
    case 'in_progress':
    case 'in progress':
    case 'active':
      return 'in_progress';
    case 'review':
    case 'completed':
    case 'analysis_complete':
      return 'review';
    case 'closed':
    case 'archived':
      return 'closed';
    default:
      return 'open';
  }
}

function dbToInvestigation(row: any): Investigation {
  return {
    id: row.id,
    caseNumber: row.case_number,
    title: row.title,
    description: row.description || '',
    userId: row.user_id,
    status: normalizeInvestigationStatus(row.status),
    priority: row.priority,
    leadInvestigator: row.lead_investigator || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    evidenceCount: row.evidence_count || 0,
    tags: row.tags || [],
  };
}

export async function syncFetchInvestigations(): Promise<Investigation[] | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return null;

  const { data, error } = await client
    .from('investigations')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[Sync] fetch investigations:', error.message);
    return null;
  }
  return (data || []).map(dbToInvestigation);
}

export function syncEnsureInvestigation(inv: Investigation): Promise<Investigation> {
  const existingCreate = pendingInvestigationCreates.get(inv.id);
  if (existingCreate) return existingCreate;

  const createPromise = (async () => {
    const client = getSupabaseClient();
    const user = await getAuthUser();
    if (!client) {
      throw new Error('Supabase is not configured. Set the project URL and publishable key.');
    }
    if (!user) {
      throw new Error('No Supabase user is signed in. Sign in before saving an investigation.');
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(inv.id);
    if (isUuid) {
      const { data: existingById, error: idLookupError } = await client
        .from('investigations')
        .select('*')
        .eq('id', inv.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (idLookupError) {
        throw new Error(`Could not check investigation ownership: ${idLookupError.message}`);
      }
      if (existingById) return dbToInvestigation(existingById);
    }

    const { data: existingByCaseNumber, error: caseLookupError } = await client
      .from('investigations')
      .select('*')
      .eq('case_number', inv.caseNumber)
      .eq('user_id', user.id)
      .maybeSingle();

    if (caseLookupError) {
      throw new Error(`Could not find the investigation in Supabase: ${caseLookupError.message}`);
    }
    if (existingByCaseNumber) return dbToInvestigation(existingByCaseNumber);

    const { data, error } = await client
      .from('investigations')
      .insert({
        ...(isUuid ? { id: inv.id } : {}),
        case_number: inv.caseNumber,
        title: inv.title,
        description: inv.description,
        user_id: user.id,
        status: normalizeInvestigationStatus(inv.status),
        priority: inv.priority,
        lead_investigator: inv.leadInvestigator || user.email,
        evidence_count: 0,
      })
      .select()
      .single();

    if (error || !data) {
      const detail = error?.message || 'No row returned';
      if (error?.code === '42501' || detail.toLowerCase().includes('row-level security')) {
        throw new Error(`Supabase blocked saving the investigation: ${detail}. Check that the authenticated user can insert rows in public.investigations.`);
      }
      if (error?.code === '23505') {
        throw new Error(`Supabase rejected this investigation because its ID or case number is already in use: ${detail}`);
      }
      throw new Error(`Could not save the investigation in Supabase: ${detail}`);
    }
    return dbToInvestigation(data);
  })();

  pendingInvestigationCreates.set(inv.id, createPromise);
  void createPromise.then(
    () => pendingInvestigationCreates.delete(inv.id),
    () => pendingInvestigationCreates.delete(inv.id)
  );
  return createPromise;
}

export function syncCreateInvestigation(inv: Investigation): Promise<Investigation | null> {
  return syncEnsureInvestigation(inv).catch((error: unknown) => {
    console.error('[Sync] ensure investigation:', error instanceof Error ? error.message : error);
    return null;
  });
}

export async function syncUpdateInvestigation(
  id: string,
  updates: Partial<Investigation>
): Promise<boolean> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return false;

  const dbUpdates: Record<string, any> = { updated_at: new Date().toISOString() };
  if (updates.status !== undefined) dbUpdates.status = updates.status;
  if (updates.priority !== undefined) dbUpdates.priority = updates.priority;
  if (updates.title !== undefined) dbUpdates.title = updates.title;
  if (updates.description !== undefined) dbUpdates.description = updates.description;
  if (updates.evidenceCount !== undefined) dbUpdates.evidence_count = updates.evidenceCount;

  const { error } = await client
    .from('investigations')
    .update(dbUpdates)
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) console.error('[Sync] update investigation:', error.message);
  return !error;
}

export async function syncDeleteInvestigation(id: string): Promise<boolean> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return false;

  const { data, error } = await client
    .from('investigations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id');

  if (error) {
    console.error('[Sync] delete investigation:', error.message);
    return false;
  }

  if (!data?.some((row) => row.id === id)) {
    const { data: remaining, error: verifyError } = await client
      .from('investigations')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!verifyError && remaining) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Evidence Items
// ---------------------------------------------------------------------------

function dbToEvidenceItem(row: any): EvidenceItem {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    userId: row.user_id,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    mediaType: row.media_type,
    sha256Hash: row.sha256_hash,
    storageUrl: row.storage_path || '',
    previewUrl: row.preview_url || row.storage_path || '',
    thumbnailUrl: row.thumbnail_data_url || undefined,
    isOriginal: row.is_original,
    verified: row.verified,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  };
}

export async function syncFetchEvidenceItems(investigationId?: string): Promise<EvidenceItem[] | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return null;

  const pageSize = 1000;
  const allRows: any[] = [];

  try {
    for (let from = 0; ; from += pageSize) {
      let query = client
        .from('evidence_items')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);

      if (investigationId) {
        query = query.eq('investigation_id', investigationId);
      }

      const { data, error } = await query;
      if (error) throw error;

      const rows = data || [];
      allRows.push(...rows);
      if (rows.length < pageSize) break;
    }

    const storagePaths = allRows
      .map((row) => row.storage_path)
      .filter((storagePath): storagePath is string => typeof storagePath === 'string' && storagePath.length > 0);
    const signedUrlsByPath = new Map<string, string>();
    const signedUrlBatchSize = 100;
    for (let index = 0; index < storagePaths.length; index += signedUrlBatchSize) {
      const paths = storagePaths.slice(index, index + signedUrlBatchSize);
      const { data, error } = await client.storage.from('evidence').createSignedUrls(paths, 3600);
      if (error) {
        console.error('[Sync] create evidence signed URLs:', error.message);
        continue;
      }
      for (const signedUrl of data || []) {
        if (signedUrl.path && signedUrl.signedUrl) {
          signedUrlsByPath.set(signedUrl.path, signedUrl.signedUrl);
        } else if (signedUrl.error) {
          console.error(`[Sync] create evidence signed URL for ${signedUrl.path || 'unknown path'}:`, signedUrl.error);
        }
      }
    }

    return allRows.map((row) => {
      const item = dbToEvidenceItem(row);
      if (item.storageUrl) {
        item.previewUrl = signedUrlsByPath.get(item.storageUrl) || item.thumbnailUrl || '';
      }
      return item;
    });
  } catch (error) {
    console.error('[Sync] fetch evidence items:', error instanceof Error ? error.message : error);
    return null;
  }
}

async function uploadEvidenceFile(
  client: NonNullable<ReturnType<typeof getSupabaseClient>>,
  storagePath: string,
  file: File | Blob,
  contentType: string,
  onProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<string> {
  if (contentType.startsWith('video/') && file.size > RESUMABLE_VIDEO_UPLOAD_THRESHOLD_BYTES) {
    const config = getSupabaseConfig();
    if (!config.url || !config.anonKey) {
      throw new Error('Supabase upload configuration is unavailable.');
    }
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError || !sessionData.session?.access_token) {
      throw new Error('Sign in to Supabase before uploading video evidence.');
    }

    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(file, {
        endpoint: `${config.url.replace(/\/+$/, '')}/storage/v1/upload/resumable`,
        headers: {
          Authorization: `Bearer ${sessionData.session.access_token}`,
          apikey: config.anonKey,
          'x-upsert': 'false',
        },
        metadata: {
          bucketName: 'evidence',
          objectName: storagePath,
          contentType,
          cacheControl: '3600',
        },
        chunkSize: RESUMABLE_VIDEO_UPLOAD_CHUNK_BYTES,
        retryDelays: [0, 1000, 3000, 5000],
        storeFingerprintForResuming: false,
        removeFingerprintOnSuccess: true,
        onProgress: (uploadedBytes, totalBytes) => onProgress?.(uploadedBytes, totalBytes),
        onError: reject,
        onSuccess: () => {
          onProgress?.(file.size, file.size);
          resolve(storagePath);
        },
      });
      upload.start();
    });
  }

  onProgress?.(0, file.size);
  const { data, error } = await client.storage
    .from('evidence')
    .upload(storagePath, file, { upsert: false, contentType });
  if (error || !data) {
    throw new Error(error?.message || 'No storage path returned.');
  }
  onProgress?.(file.size, file.size);
  return data.path || storagePath;
}

export async function syncAddEvidenceItem(
  item: Omit<EvidenceItem, 'id' | 'createdAt'>,
  file: File | Blob,
  hashesPromise: Promise<{ sha256: string; md5: string }>,
  onUploadProgress?: (uploadedBytes: number, totalBytes: number) => void,
): Promise<EvidenceItem> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client) {
    throw new Error('Supabase is not configured. Configure the Supabase URL and publishable key to upload evidence.');
  }
  if (!user) {
    throw new Error('Sign in to Supabase before uploading evidence to the database.');
  }

  let investigationId = item.investigationId;
  const investigationCreate = pendingInvestigationCreates.get(item.investigationId);
  if (investigationCreate) {
    const savedInvestigation = await investigationCreate;
    if (!savedInvestigation) {
      throw new Error('The selected investigation could not be saved to the database.');
    }
    investigationId = savedInvestigation.id;
  }

  const safeName = item.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${user.id}/${investigationId}/${crypto.randomUUID()}_${safeName}`;
  const uploadPromise = uploadEvidenceFile(
    client,
    storagePath,
    file,
    file.type || item.mimeType,
    onUploadProgress,
  );
  const [uploadResult, hashesResult] = await Promise.allSettled([uploadPromise, hashesPromise]);
  if (uploadResult.status === 'rejected') {
    throw new Error(`Evidence file upload failed: ${getEvidenceUploadErrorMessage(uploadResult.reason)}`);
  }
  const uploadedPath = uploadResult.value;
  if (hashesResult.status === 'rejected') {
    const { error: cleanupError } = await client.storage.from('evidence').remove([uploadedPath]);
    if (cleanupError) console.error('[Sync] remove evidence upload after hash failure:', cleanupError.message);
    throw new Error(`Evidence hash failed: ${hashesResult.reason instanceof Error ? hashesResult.reason.message : 'Hash calculation failed'}`);
  }
  const { sha256: sha256Hash, md5: md5Hash } = hashesResult.value;
  const baseEvidencePayload = {
    investigation_id: investigationId,
    user_id: user.id,
    file_name: item.fileName,
    file_size: item.fileSize,
    mime_type: item.mimeType,
    media_type: item.mediaType,
    sha256_hash: sha256Hash,
    storage_path: uploadedPath,
    preview_url: '',
    thumbnail_data_url: item.thumbnailUrl || null,
    is_original: item.isOriginal,
    verified: item.verified,
    metadata: item.metadata || {},
  };

  let insertResponse = await client
    .from('evidence_items')
    .insert({
      ...baseEvidencePayload,
      item_tag: crypto.randomUUID(),
      md5_hash: md5Hash,
    })
    .select()
    .single();

  if (insertResponse.error && (['42703', 'PGRST204'].includes(insertResponse.error.code || '') || /item_tag|md5_hash/i.test(insertResponse.error.message))) {
    // Retry insert without optional newer columns if database migration hasn't been run
    insertResponse = await client
      .from('evidence_items')
      .insert(baseEvidencePayload)
      .select()
      .single();
  }

  const { data, error } = insertResponse;

  if (error || !data) {
    const { error: cleanupError } = await client.storage.from('evidence').remove([uploadedPath]);
    if (cleanupError) console.error('[Sync] remove orphaned evidence upload:', cleanupError.message);
    throw new Error(`Evidence database record could not be saved: ${error?.message || 'No row returned'}`);
  }
  const savedItem = dbToEvidenceItem(data);
  savedItem.previewUrl = (await getEvidenceSignedUrl(uploadedPath)) || savedItem.thumbnailUrl || '';
  return savedItem;
}

export async function syncDeleteEvidenceItem(id: string): Promise<boolean> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return false;

  const { error } = await client
    .from('evidence_items')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) console.error('[Sync] delete evidence:', error.message);
  return !error;
}

export async function syncUpdateEvidenceThumbnail(id: string, thumbnailUrl: string): Promise<void> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) throw new Error('Sign in to Supabase before saving the video preview frame.');

  const { error } = await client
    .from('evidence_items')
    .update({ thumbnail_data_url: thumbnailUrl })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id')
    .single();

  if (error) {
    throw new Error(`Video preview frame could not be saved in Supabase: ${error.message}`);
  }
}

export async function syncUpdateEvidenceMetadata(id: string, metadata: EvidenceMetadata): Promise<void> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) throw new Error('Sign in to Supabase before saving evidence metadata.');

  const { error } = await client
    .from('evidence_items')
    .update({ metadata })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id')
    .single();

  if (error) {
    throw new Error(`Evidence metadata could not be saved in Supabase: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Analysis Findings
// ---------------------------------------------------------------------------

function dbToFinding(row: any): AnalysisFinding {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    evidenceId: row.evidence_id,
    title: row.title,
    severity: row.severity,
    category: row.category,
    observedEvidence: row.observed_evidence,
    simpleExplanation: row.simple_explanation || undefined,
    technicalExplanation: row.technical_explanation || undefined,
    detectionMethod: row.detection_method,
    detectorVersion: row.detector_version || 'local',
    rawDetectorScore: row.raw_detector_score || undefined,
    confidenceScore: row.confidence_score || undefined,
    limitations: row.limitations || undefined,
    plainEnglishSummary: row.plain_english_summary || undefined,
    createdAt: row.created_at,
  };
}

export async function syncFetchFindings(investigationId?: string): Promise<AnalysisFinding[] | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return null;

  let query = client
    .from('analysis_findings')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (investigationId) {
    query = query.eq('investigation_id', investigationId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[Sync] fetch findings:', error.message);
    return null;
  }
  return (data || []).map(dbToFinding);
}

export async function syncAddFinding(finding: Omit<AnalysisFinding, 'id' | 'createdAt'>): Promise<AnalysisFinding | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return null;

  const { data, error } = await client
    .from('analysis_findings')
    .insert({
      investigation_id: finding.investigationId,
      evidence_id: finding.evidenceId,
      user_id: user.id,
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      observed_evidence: finding.observedEvidence,
      plain_english_summary: finding.plainEnglishSummary || finding.simpleExplanation || '',
      simple_explanation: finding.simpleExplanation || null,
      technical_explanation: finding.technicalExplanation || null,
      detection_method: finding.detectionMethod,
      detector_version: finding.detectorVersion || 'local',
      raw_detector_score: finding.rawDetectorScore ?? null,
      confidence_score: finding.confidenceScore ?? null,
      limitations: finding.limitations || null,
    })
    .select()
    .single();

  if (error || !data) {
    console.error('[Sync] add finding:', error?.message);
    return null;
  }
  return dbToFinding(data);
}

export async function syncSavePuterImageDetection(
  result: PuterVisualAssessmentResult,
): Promise<boolean> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return false;

  const { error } = await client.from('ai_image_detection_runs').insert({
    investigation_id: result.investigationId,
    evidence_id: result.evidenceId,
    user_id: user.id,
    file_name: result.fileName,
    image_sha256: result.sha256,
    mime_type: result.mimeType,
    image_width: result.width,
    image_height: result.height,
    model_id: result.modelId,
    model_name: result.modelName,
    model_version: result.modelVersion,
    provider: result.provider,
    assessment: result.assessment,
    observations: result.observations,
    request_usage: result.usage,
    processing_status: result.processingStatus,
    limitations: result.limitations,
    analyzed_at: result.timestamp,
  });

  if (error) {
    console.error('[Sync] save Puter AI Image Detection result:', error.message);
    throw new Error(`The AI Image Detection result could not be saved to Supabase: ${error.message}`);
  }
  return true;
}

export async function syncSaveDeepSafeImageDetection(
  result: DeepSafeImageAnalysis,
): Promise<void> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) {
    throw new Error('Sign in with Supabase before saving a DeepSafe analysis.');
  }

  const { error } = await client.from('ai_image_detection_runs').insert({
    investigation_id: result.investigation_id,
    evidence_id: result.evidence_id,
    user_id: user.id,
    file_name: result.file_name,
    file_size: result.file_size,
    image_sha256: result.image.sha256,
    mime_type: result.mime_type,
    image_width: result.image.width,
    image_height: result.image.height,
    model_id: 'deepsafe-image-voting',
    model_name: 'DeepSafe NPR + UniversalFakeDetect',
    model_version: result.provider_revision,
    provider: result.provider,
    assessment: result.ensemble.assessment,
    observations: result.ensemble.observations,
    model_outputs: result.models,
    ensemble_method: result.ensemble.method,
    fake_votes: result.ensemble.fake_votes,
    total_votes: result.ensemble.total_votes,
    duration_ms: result.duration_ms,
    error_detail: result.error_detail,
    request_usage: {},
    processing_status: result.processing_status,
    limitations: [
      'Model sigmoid scores are not calibrated probabilities of image origin.',
      'No decision threshold or combined model verdict is validated for this use.',
      'The serving SDK may return a default-threshold class field; VexaLens does not use it as an assessment.',
      'This research-grade screening result requires independent forensic corroboration.',
    ],
    analyzed_at: result.analyzed_at,
  });

  if (error) {
    console.error('[Sync] save DeepSafe image analysis:', error.message);
    throw new Error(`The DeepSafe analysis could not be saved to Supabase: ${error.message}`);
  }
}

export async function syncFetchDeepSafeImageDetectionHistory(
  investigationId: string,
  evidenceId: string,
): Promise<DeepSafeImageAnalysis[]> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) {
    throw new Error('Sign in with Supabase to load DeepSafe analysis history.');
  }

  const { data, error } = await client
    .from('ai_image_detection_runs')
    .select(
      'investigation_id, evidence_id, file_name, file_size, image_sha256, mime_type, image_width, image_height, model_version, provider, assessment, observations, model_outputs, ensemble_method, fake_votes, total_votes, duration_ms, error_detail, processing_status, analyzed_at',
    )
    .eq('investigation_id', investigationId)
    .eq('evidence_id', evidenceId)
    .eq('model_id', 'deepsafe-image-voting')
    .order('analyzed_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('[Sync] fetch DeepSafe image analysis history:', error.message);
    throw new Error(`DeepSafe analysis history could not be loaded: ${error.message}`);
  }

  return (data || []).map((row) => {
    const models = row.model_outputs as DeepSafeImageAnalysis['models'];
    const analysisVersion = Object.values(models || {}).some((model) => model?.model_version?.startsWith('1.1.'))
      ? '1.1.0'
      : '1.0.0';
    const nullableCount = (value: unknown): number | null => {
      if (value === null || value === undefined) return null;
      const count = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(count) ? count : null;
    };
    return {
      provider: 'DeepSafe',
      provider_revision: row.model_version,
      analysis_version: analysisVersion,
      investigation_id: row.investigation_id,
      evidence_id: row.evidence_id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size: Number(row.file_size || 0),
      image: {
        mime_type: row.mime_type,
        format: row.mime_type === 'image/png' ? 'PNG' : 'JPEG',
        width: row.image_width,
        height: row.image_height,
        sha256: row.image_sha256,
      },
      models,
      ensemble: {
        method: row.ensemble_method || 'Legacy DeepSafe hard voting',
        assessment: row.assessment as DeepSafeImageAnalysis['ensemble']['assessment'],
        fake_votes: nullableCount(row.fake_votes),
        total_votes: nullableCount(row.total_votes),
        score: null,
        observations: Array.isArray(row.observations) ? row.observations : [],
      },
      processing_status: row.processing_status as DeepSafeImageAnalysis['processing_status'],
      duration_ms: Number(row.duration_ms || 0),
      analyzed_at: row.analyzed_at,
      error_detail: row.error_detail,
    };
  });
}

export async function syncDeleteFinding(id: string): Promise<boolean> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return false;

  const { error } = await client
    .from('analysis_findings')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) console.error('[Sync] delete finding:', error.message);
  return !error;
}

export type PersistedScreenshotAnalysis = Omit<
  ScreenshotAnalysisResult,
  'originalDataUrl' | 'heatmapDataUrl' | 'annotatedDataUrl' | 'moduleOverlayDataUrls'
> & {
  originalDataUrl?: string;
  heatmapDataUrl?: string;
  annotatedDataUrl?: string;
  moduleOverlayDataUrls?: Record<string, string>;
};

export interface ScreenshotAnalysisRecord {
  id: string;
  investigationId: string | null;
  fileName: string;
  sha256: string;
  createdAt: string;
  result: PersistedScreenshotAnalysis;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const LOCAL_SCREENSHOT_STORAGE_KEY = 'vexalens_local_screenshot_analyses';

function getLocalScreenshotAnalyses(): ScreenshotAnalysisRecord[] {
  try {
    const raw = localStorage.getItem(LOCAL_SCREENSHOT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalScreenshotAnalysis(record: ScreenshotAnalysisRecord): void {
  try {
    const existing = getLocalScreenshotAnalyses();
    const filtered = existing.filter((r) => r.id !== record.id);
    localStorage.setItem(LOCAL_SCREENSHOT_STORAGE_KEY, JSON.stringify([record, ...filtered].slice(0, 50)));
  } catch {}
}

export async function syncSaveScreenshotAnalysis(
  analysis: ScreenshotAnalysisResult,
  investigation?: Investigation,
  evidenceId?: string
): Promise<ScreenshotAnalysisRecord> {
  const client = getSupabaseClient();
  const user = await getAuthUser();

  let savedInvestigationId: string | null = null;
  if (investigation && client && user) {
    try {
      const savedInvestigation = await syncEnsureInvestigation(investigation);
      savedInvestigationId = savedInvestigation.id;
    } catch {}
  }

  const snapshot = JSON.parse(JSON.stringify({
    ...analysis,
    originalDataUrl: undefined,
    heatmapDataUrl: undefined,
    annotatedDataUrl: undefined,
    moduleOverlayDataUrls: undefined,
    suspiciousRegions: analysis.suspiciousRegions.map((region) => ({
      ...region,
      cropDataUrl: undefined,
    })),
  })) as Record<string, unknown>;

  // Fallback helper to save in local session
  const fallbackToLocal = (): ScreenshotAnalysisRecord => {
    const localRecord: ScreenshotAnalysisRecord = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      investigationId: savedInvestigationId,
      fileName: analysis.fileName,
      sha256: analysis.sha256,
      createdAt: new Date().toISOString(),
      result: snapshot as PersistedScreenshotAnalysis,
    };
    saveLocalScreenshotAnalysis(localRecord);
    return localRecord;
  };

  if (!client || !user) {
    return fallbackToLocal();
  }

  let savedEvidenceId: string | null = null;
  if (evidenceId && isUuid(evidenceId)) {
    try {
      const { data: evidence } = await client
        .from('evidence_items')
        .select('id')
        .eq('id', evidenceId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (evidence) savedEvidenceId = evidence.id;
    } catch {}
  }

  try {
    const { data, error } = await client
      .from('screenshot_analyses')
      .insert({
        user_id: user.id,
        investigation_id: savedInvestigationId,
        evidence_id: savedEvidenceId,
        file_name: analysis.fileName,
        sha256_hash: analysis.sha256,
        detector_version: String(analysis.parameters.engine || 'unknown'),
        parameters: analysis.parameters,
        result_snapshot: snapshot,
      })
      .select('id, investigation_id, file_name, sha256_hash, created_at, result_snapshot')
      .single();

    if (error || !data) {
      const isMissingTable = error?.message && (
        error.message.includes('screenshot_analyses') ||
        error.message.includes('schema cache') ||
        error.message.includes('PGRST204')
      );
      if (isMissingTable) {
        return fallbackToLocal();
      }
      throw new Error(`Could not save screenshot analysis: ${error?.message || 'Unknown database error.'}`);
    }

    return {
      id: data.id,
      investigationId: data.investigation_id,
      fileName: data.file_name,
      sha256: data.sha256_hash,
      createdAt: data.created_at,
      result: data.result_snapshot as PersistedScreenshotAnalysis,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('screenshot_analyses') || msg.includes('schema cache') || msg.includes('PGRST204')) {
      return fallbackToLocal();
    }
    throw err;
  }
}

export async function syncFetchScreenshotAnalyses(
  investigation: Investigation
): Promise<ScreenshotAnalysisRecord[] | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) {
    return getLocalScreenshotAnalyses().filter((r) => !r.investigationId || r.investigationId === investigation.id);
  }

  let savedInvestigationId = investigation.id;
  try {
    const savedInvestigation = await syncEnsureInvestigation(investigation);
    savedInvestigationId = savedInvestigation.id;
  } catch {}

  try {
    const { data, error } = await client
      .from('screenshot_analyses')
      .select('id, investigation_id, file_name, sha256_hash, created_at, result_snapshot')
      .eq('user_id', user.id)
      .eq('investigation_id', savedInvestigationId)
      .order('created_at', { ascending: false });

    if (error) {
      const isMissingTable = error.message && (
        error.message.includes('screenshot_analyses') ||
        error.message.includes('schema cache') ||
        error.message.includes('PGRST204')
      );
      if (isMissingTable) {
        const local = getLocalScreenshotAnalyses();
        return local.filter((r) => !r.investigationId || r.investigationId === savedInvestigationId);
      }
      throw new Error(`Could not load screenshot analysis history: ${error.message}`);
    }
    return (data || []).map((row) => ({
      id: row.id,
      investigationId: row.investigation_id,
      fileName: row.file_name,
      sha256: row.sha256_hash,
      createdAt: row.created_at,
      result: row.result_snapshot as PersistedScreenshotAnalysis,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('screenshot_analyses') || msg.includes('schema cache') || msg.includes('PGRST204')) {
      const local = getLocalScreenshotAnalyses();
      return local.filter((r) => !r.investigationId || r.investigationId === savedInvestigationId);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Provenance / Chain of Custody
// ---------------------------------------------------------------------------

function dbToProvenance(row: any): ProvenanceEvent {
  return {
    id: row.id,
    evidenceId: row.evidence_id,
    investigationId: row.investigation_id,
    actionType: row.action_type,
    actor: row.actor,
    recordedSha256: row.recorded_sha256,
    verifiedMatch: row.verified_match,
    notes: row.notes || '',
    timestamp: row.created_at,
    sourceUrl: row.source_url || undefined,
    sourceStatus: row.source_status || undefined,
  };
}

export async function syncFetchProvenanceEvents(evidenceId?: string): Promise<ProvenanceEvent[] | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return null;

  let query = client
    .from('provenance_checks')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (evidenceId) {
    query = query.eq('evidence_id', evidenceId);
  }

  const { data, error } = await query;
  if (error) {
    console.error('[Sync] fetch provenance:', error.message);
    return null;
  }
  return (data || []).map(dbToProvenance);
}

export async function syncAddProvenanceEvent(event: Omit<ProvenanceEvent, 'id' | 'timestamp'>): Promise<boolean> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return false;

  const { error } = await client.from('provenance_checks').insert({
    investigation_id: event.investigationId,
    evidence_id: event.evidenceId,
    user_id: user.id,
    action_type: event.actionType,
    actor: event.actor,
    recorded_sha256: event.recordedSha256,
    verified_match: event.verifiedMatch,
    notes: event.notes,
    source_url: event.sourceUrl || null,
    source_status: event.sourceStatus || null,
  });

  if (error) console.error('[Sync] add provenance:', error.message);
  return !error;
}

// ---------------------------------------------------------------------------
// Activity Logs
// ---------------------------------------------------------------------------

function dbToActivityLog(row: any): ActivityLog {
  return {
    id: row.id,
    userId: row.user_id,
    investigationId: row.investigation_id || undefined,
    caseNumber: row.case_number || undefined,
    eventType: row.event_type,
    description: row.description,
    timestamp: row.created_at,
  };
}

export async function syncFetchActivityLogs(): Promise<ActivityLog[] | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return null;

  const { data, error } = await client
    .from('activity_logs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('[Sync] fetch activity logs:', error.message);
    return null;
  }
  return (data || []).map(dbToActivityLog);
}

export async function syncLogActivity(
  eventType: string,
  description: string,
  investigationId?: string,
  caseNumber?: string
): Promise<boolean> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return false;

  const { error } = await client.from('activity_logs').insert({
    user_id: user.id,
    investigation_id: investigationId || null,
    case_number: caseNumber || null,
    event_type: eventType,
    description,
    metadata: {},
  });

  if (error) console.error('[Sync] log activity:', error.message);
  return !error;
}

// ---------------------------------------------------------------------------
// Permanent Reports Repository
// ---------------------------------------------------------------------------

function dbToReport(row: any): PermanentReportRecord {
  return {
    id: row.id,
    reportNumber: row.report_number,
    caseId: row.investigation_id || undefined,
    historicalCaseId: row.historical_case_id || row.investigation_id || 'UNASSIGNED',
    historicalCaseNumber: row.historical_case_number || row.case_number || '',
    title: row.title,
    version: row.version || 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
    summary: row.summary,
    conclusion: row.conclusion || '',
    findingCount: row.finding_count || 0,
    evidenceCount: row.evidence_count || 0,
    reportSnapshot: row.report_snapshot || null,
    rawJsonExport: row.raw_json_export || undefined,
    pdfExportAvailable: row.pdf_export_available || false,
    caseDeleted: row.case_deleted || false,
    caseDeletedAt: row.case_deleted_at || undefined,
    evidenceRetained: row.evidence_retained !== false,
    evidenceRetentionPolicy: row.evidence_retention_policy || 'statutory_permanent',
    tamperVerified: row.tamper_verified !== false,
    auditSignature: row.audit_signature || undefined,
  };
}

export async function syncFetchReports(): Promise<PermanentReportRecord[] | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return null;

  const { data, error } = await client
    .from('reports')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[Sync] fetch reports:', error.message);
    return null;
  }
  return (data || []).map(dbToReport);
}

export async function syncSaveReport(record: PermanentReportRecord): Promise<boolean> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) return false;

  // Build the DB row with the columns that actually exist in this schema
  const row: Record<string, any> = {
    id: record.id,
    user_id: user.id,
    investigation_id: record.caseId || null,
    report_number: record.reportNumber,
    title: record.title,
    summary: record.summary,
    findings_snapshot: record.reportSnapshot?.findings || [],
    evidence_inventory: record.reportSnapshot?.evidenceList || [],
    report_snapshot: record.reportSnapshot || null,
    historical_case_id: record.historicalCaseId,
    historical_case_number: record.historicalCaseNumber,
    version: record.version || 1,
    case_deleted: record.caseDeleted || false,
    evidence_retained: record.evidenceRetained !== false,
    tamper_verified: record.tamperVerified !== false,
    audit_signature: record.auditSignature || null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await client.from('reports').upsert(row, { onConflict: 'report_number' });
  if (error) console.error('[Sync] save report:', error.message);
  return !error;
}

export async function syncFetchDocumentAnalyses(): Promise<DocumentAnalysisResult[]> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) throw new Error('Sign in to Supabase to view document analyses.');
  const { data, error } = await client
    .from('document_analyses')
    .select('id, evidence_id, investigation_id, analysis_status, result, report_storage_path, report_sha256, truthscan_pdf_job_id, truthscan_pdf_status, truthscan_pdf_model, truthscan_pdf_modules, truthscan_pdf_result, truthscan_pdf_credits_deducted, truthscan_pdf_error, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) {
    if (error.code === 'PGRST205' || error.code === 'PGRST204' || error.code === '42P01' ||
        /could not find the (?:table|column).*document_analyses.*schema cache/i.test(error.message) ||
        /truthscan_pdf_.*schema cache/i.test(error.message)) {
      throw new Error(
        'Document analysis history is not fully set up in Supabase. Apply supabase/migrations/20261033_document_revision_archaeologist.sql and 20261034_truthscan_pdf_detector.sql in the Supabase SQL Editor, then reload the schema cache and refresh this page.'
      );
    }
    throw new Error(`Document analysis history could not be loaded: ${error.message}`);
  }
  return (data || []).map((row) => {
    const storedResult: unknown = row.result;
    if (!isDocumentAnalysisResult(storedResult)) {
      throw new Error(`Document analysis ${row.id} contains an invalid stored result.`);
    }
    return {
      ...storedResult,
      id: row.id,
      evidenceId: row.evidence_id || storedResult.evidenceId,
      investigationId: row.investigation_id || storedResult.investigationId,
      status: row.analysis_status as DocumentAnalysisResult['status'],
      reportStoragePath: row.report_storage_path || undefined,
      reportSha256: row.report_sha256 || undefined,
      truthScanPdf: ['uploading', 'pending', 'processing', 'done', 'failed'].includes(row.truthscan_pdf_status)
        ? {
          jobId: row.truthscan_pdf_job_id || undefined,
          status: row.truthscan_pdf_status,
          model: row.truthscan_pdf_model || 'pdf_detector',
          modules: Array.isArray(row.truthscan_pdf_modules) ? row.truthscan_pdf_modules : [],
          result: row.truthscan_pdf_result && typeof row.truthscan_pdf_result === 'object'
            ? row.truthscan_pdf_result
            : undefined,
          creditsDeducted: typeof row.truthscan_pdf_credits_deducted === 'number'
            ? row.truthscan_pdf_credits_deducted
            : undefined,
          error: row.truthscan_pdf_error || undefined,
        }
        : undefined,
    };
  });
}

function isDocumentAnalysisResult(value: unknown): value is DocumentAnalysisResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' &&
    typeof record.evidenceId === 'string' &&
    typeof record.investigationId === 'string' &&
    typeof record.filename === 'string' &&
    (record.format === 'DOCX' || record.format === 'PDF' || record.format === 'UNKNOWN') &&
    (record.status === 'parsed' || record.status === 'partially_parsed' || record.status === 'rejected') &&
    typeof record.sha256 === 'string' &&
    typeof record.fileSize === 'number' &&
    Array.isArray(record.findings) &&
    Array.isArray(record.inconsistencies) &&
    Array.isArray(record.missingMetadata) &&
    Array.isArray(record.limitations) &&
    Array.isArray(record.errors) &&
    Boolean(record.properties && typeof record.properties === 'object') &&
    Boolean(record.structure && typeof record.structure === 'object');
}

export async function syncSaveDocumentReport(
  analysisId: string,
  investigationId: string,
  report: Blob,
  reportSha256: string
): Promise<string> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user) throw new Error('Sign in to Supabase before saving a forensic report.');
  if (!/^[a-f0-9]{64}$/.test(reportSha256)) throw new Error('A valid SHA-256 digest is required for the report.');
  if (report.type !== 'application/pdf' || report.size === 0) throw new Error('The generated report must be a non-empty PDF.');

  const path = `${user.id}/${investigationId}/reports/${analysisId}_${crypto.randomUUID()}.pdf`;
  const { data: upload, error: uploadError } = await client.storage
    .from('evidence')
    .upload(path, report, { upsert: false, contentType: 'application/pdf' });
  if (uploadError || !upload) throw new Error(`Forensic report upload failed: ${uploadError?.message || 'No storage path returned'}`);

  const { error: updateError } = await client
    .from('document_analyses')
    .update({ report_storage_path: upload.path || path, report_sha256: reportSha256 })
    .eq('id', analysisId)
    .eq('user_id', user.id)
    .select('id')
    .single();
  if (updateError) {
    const { error: cleanupError } = await client.storage.from('evidence').remove([upload.path || path]);
    if (cleanupError) console.error('[Sync] remove unlinked document report:', cleanupError.message);
    throw new Error(`Report uploaded but its analysis record could not be updated: ${updateError.message}`);
  }
  return upload.path || path;
}

export async function syncGetDocumentReportUrl(storagePath: string, filename: string): Promise<string> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user || !storagePath.startsWith(`${user.id}/`)) {
    throw new Error('This forensic report is unavailable to the current account.');
  }
  const { data, error } = await client.storage
    .from('evidence')
    .createSignedUrl(storagePath, 300, { download: filename });
  if (error || !data?.signedUrl) throw new Error(`Forensic report download link could not be created: ${error?.message || 'No signed URL returned'}`);
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// Signed URL for evidence file download
// ---------------------------------------------------------------------------

export async function getEvidenceSignedUrl(storagePath: string): Promise<string | null> {
  const client = getSupabaseClient();
  const user = await getAuthUser();
  if (!client || !user || !storagePath) return null;

  const { data, error } = await client.storage
    .from('evidence')
    .createSignedUrl(storagePath, 3600); // 1-hour expiry

  if (error) {
    console.error('[Sync] signed URL:', error.message);
    return null;
  }
  return data?.signedUrl || null;
}
