import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock3, Download, FileSearch, Hash, ShieldCheck, Smartphone } from 'lucide-react';
import type { Investigation, UserProfile } from '@/types/forensics';
import {
  buildGhostRecoverReport,
  createEmptyGhostRecoverStore,
  createGhostRecoverCustodyEntry,
  getGhostRecoverCaseRecord,
  GHOSTRECOVER_STORAGE_KEY,
  parseGhostRecoverStore,
  verifyGhostRecoverCustodyChain,
  type GhostRecoverApp,
  type GhostRecoverArtifact,
  type GhostRecoverCustodyEntry,
  type GhostRecoverEventType,
  type GhostRecoverPlatform,
  type GhostRecoverTimelineEvent,
  type GhostRecoverStore,
} from '@/lib/forensics/ghostRecover';
import { calculateEvidenceHashes, calculateSHA256 } from '@/lib/forensics/crypto';

interface GhostRecoverViewProps {
  investigations: Investigation[];
  currentCase?: Investigation;
  user: UserProfile;
}

const SOURCE_APPS: GhostRecoverApp[] = [
  'WhatsApp',
  'Snapchat',
  'Instagram Vanish Mode',
  'Telegram Secret Chats',
  'Signal',
  'Other',
];

const EVENT_TYPES: { value: GhostRecoverEventType; label: string }[] = [
  { value: 'message_sent', label: 'Message sent (reported/recorded)' },
  { value: 'message_received', label: 'Message received (reported/recorded)' },
  { value: 'disappearing_mode_enabled', label: 'Disappearing mode observed' },
  { value: 'backup_created', label: 'Backup or export created' },
  { value: 'notification_observed', label: 'Notification observed' },
  { value: 'investigator_note', label: 'Investigator note' },
  { value: 'other', label: 'Other event' },
];

const localDateTimeValue = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};

const makeId = () => crypto.randomUUID();

export const GhostRecoverView: React.FC<GhostRecoverViewProps> = ({
  investigations,
  currentCase,
  user,
}) => {
  const [store, setStore] = useState<GhostRecoverStore>(createEmptyGhostRecoverStore);
  const [caseId, setCaseId] = useState(currentCase?.id || investigations[0]?.id || '');
  const [sourceApp, setSourceApp] = useState<GhostRecoverApp>('WhatsApp');
  const [platform, setPlatform] = useState<GhostRecoverPlatform>('Android');
  const [acquisitionMethod, setAcquisitionMethod] = useState('Investigator-provided export or backup file');
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [eventType, setEventType] = useState<GhostRecoverEventType>('investigator_note');
  const [eventTime, setEventTime] = useState(localDateTimeValue);
  const [participant, setParticipant] = useState('');
  const [eventSummary, setEventSummary] = useState('');
  const [eventArtifactId, setEventArtifactId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [custodyCheck, setCustodyCheck] = useState<{ valid: boolean; checkedCount: number; invalidIndex: number | null } | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(GHOSTRECOVER_STORAGE_KEY);
      if (saved) setStore(parseGhostRecoverStore(saved));
    } catch (loadError) {
      setError(loadError instanceof Error
        ? `Saved GhostRecover records could not be loaded: ${loadError.message}`
        : 'Saved GhostRecover records could not be loaded.');
    } finally {
      setStorageLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!investigations.some((item) => item.id === caseId)) {
      setCaseId(
        investigations.find((item) => item.id === currentCase?.id)?.id ||
        investigations[0]?.id ||
        '',
      );
    }
  }, [currentCase?.id, investigations, caseId]);

  const selectedCase = investigations.find((item) => item.id === caseId);
  const caseRecord = useMemo(
    () => getGhostRecoverCaseRecord(store, caseId),
    [store, caseId],
  );
  const operator = user.fullName || user.email || 'Unspecified investigator';

  const saveCaseRecord = (record: ReturnType<typeof getGhostRecoverCaseRecord>) => {
    if (!caseId) return;
    const nextStore: GhostRecoverStore = {
      ...store,
      cases: { ...store.cases, [caseId]: record },
    };
    setStore(nextStore);
    setCustodyCheck(null);
    try {
      window.localStorage.setItem(GHOSTRECOVER_STORAGE_KEY, JSON.stringify(nextStore));
      setError('');
      setMessage('Record saved in this browser.');
    } catch (saveError) {
      const reason = saveError instanceof Error ? saveError.message : 'Browser storage is unavailable.';
      setError(`Record is available only in this page session because local storage failed: ${reason}`);
      setMessage('');
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!selectedCase || !consentConfirmed) {
      setError('Select a case and confirm you are authorized to examine this file.');
      return;
    }

    setBusy(true);
    setProgress(0);
    setError('');
    setMessage('');
    try {
      const hashes = await calculateEvidenceHashes(file, ({ processedBytes, totalBytes }) => {
        setProgress(totalBytes ? Math.round((processedBytes / totalBytes) * 100) : 100);
      });
      const artifact: GhostRecoverArtifact = {
        id: makeId(),
        caseId: selectedCase.id,
        caseNumber: selectedCase.caseNumber,
        fileName: file.name,
        fileSizeBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
        sha256: hashes.sha256,
        sourceApp,
        platform,
        acquisitionMethod,
        importedAt: new Date().toISOString(),
        operator,
      };
      const custodyInput = {
        id: makeId(),
        caseId: selectedCase.id,
        action: 'artifact_hashed' as const,
        actor: operator,
        recordedAt: new Date().toISOString(),
        subjectId: artifact.id,
        subjectSha256: artifact.sha256,
      };
      const previousDigest = caseRecord.custody.at(-1)?.entrySha256 || null;
      const custody = await createGhostRecoverCustodyEntry(custodyInput, previousDigest);
      saveCaseRecord({
        ...caseRecord,
        artifacts: [artifact, ...caseRecord.artifacts],
        custody: [...caseRecord.custody, custody],
      });
    } catch (importError) {
      setError(importError instanceof Error ? `File hashing failed: ${importError.message}` : 'File hashing failed.');
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const handleAddTimelineEvent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCase || !consentConfirmed) {
      setError('Select a case and confirm you are authorized to record these observations.');
      return;
    }
    if (!eventSummary.trim()) {
      setError('Enter a short factual description for the timeline event.');
      return;
    }
    const occurredAtDate = new Date(eventTime);
    if (!Number.isFinite(occurredAtDate.getTime())) {
      setError('Enter a valid event date and time.');
      return;
    }

    setBusy(true);
    setError('');
    setMessage('');
    try {
      const timelineEvent: GhostRecoverTimelineEvent = {
        id: makeId(),
        caseId: selectedCase.id,
        occurredAt: occurredAtDate.toISOString(),
        recordedAt: new Date().toISOString(),
        sourceApp,
        eventType,
        participant: participant.trim(),
        summary: eventSummary.trim(),
        artifactId: caseRecord.artifacts.some((artifact) => artifact.id === eventArtifactId)
          ? eventArtifactId
          : null,
      };
      const subjectSha256 = await calculateSHA256(new TextEncoder().encode(JSON.stringify(timelineEvent)));
      const custodyInput = {
        id: makeId(),
        caseId: selectedCase.id,
        action: 'timeline_event_recorded' as const,
        actor: operator,
        recordedAt: new Date().toISOString(),
        subjectId: timelineEvent.id,
        subjectSha256,
      };
      const previousDigest = caseRecord.custody.at(-1)?.entrySha256 || null;
      const custody = await createGhostRecoverCustodyEntry(custodyInput, previousDigest);
      saveCaseRecord({
        ...caseRecord,
        timeline: [timelineEvent, ...caseRecord.timeline],
        custody: [...caseRecord.custody, custody],
      });
      setEventSummary('');
      setParticipant('');
      setEventTime(localDateTimeValue());
    } catch (recordError) {
      setError(recordError instanceof Error ? `Timeline entry could not be recorded: ${recordError.message}` : 'Timeline entry could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyChain = async () => {
    setBusy(true);
    setError('');
    try {
      setCustodyCheck(await verifyGhostRecoverCustodyChain(caseRecord.custody));
    } catch (verifyError) {
      setError(verifyError instanceof Error ? `Custody verification failed: ${verifyError.message}` : 'Custody verification failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadReport = async () => {
    if (!selectedCase) {
      setError('Select a case before creating a report.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const report = await buildGhostRecoverReport(
        selectedCase.caseNumber,
        caseRecord.artifacts,
        caseRecord.timeline,
        caseRecord.custody,
        new Date().toISOString(),
      );
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ghostrecover-${selectedCase.caseNumber.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage('Report downloaded. Keep it with the original acquisition records.');
    } catch (reportError) {
      setError(reportError instanceof Error ? `Report could not be created: ${reportError.message}` : 'Report could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const sortedTimeline = [...caseRecord.timeline].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 text-slate-100 sm:p-6">
      <header className="rounded-2xl border border-cyan-900/70 bg-slate-900 p-5 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-cyan-950 p-3 text-cyan-300"><ShieldCheck className="h-6 w-6" /></div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Investigator-provided evidence workspace</p>
            <h1 className="mt-1 text-2xl font-black sm:text-3xl">GhostRecover</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
              Hash authorized exports or backup files, record investigator observations, and build a case timeline.
              This tool does not connect to messaging apps or recover deleted or disappearing content.
            </p>
          </div>
        </div>
      </header>

      <div role="note" className="flex gap-3 rounded-xl border border-amber-800/70 bg-amber-950/30 p-4 text-xs leading-5 text-amber-100">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          <strong>Scope and handling:</strong> Only use files you are authorized to examine. Files are hashed in your browser and are not uploaded or retained by this module; case metadata and timeline notes are stored unencrypted in this browser&apos;s local storage. A browser import is not a hardware write blocker. Use approved acquisition procedures and a validated write blocker for device examinations.
        </p>
      </div>

      {!storageLoaded && <p role="status" className="text-sm text-slate-400">Loading local case records…</p>}
      {error && <p role="alert" className="rounded-lg border border-rose-900 bg-rose-950/40 p-3 text-sm text-rose-200">{error}</p>}
      {message && <p role="status" className="rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">{message}</p>}

      <section className="grid gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:grid-cols-2 sm:p-5">
        <label className="space-y-2 text-xs font-semibold text-slate-300">
          Investigation case
          <select
            value={caseId}
            onChange={(event) => {
              setCaseId(event.target.value);
              setCustodyCheck(null);
              setError('');
              setMessage('');
            }}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
          >
            <option value="">Select a case</option>
            {investigations.map((investigation) => (
              <option key={investigation.id} value={investigation.id}>
                {investigation.caseNumber} — {investigation.title}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end text-xs text-slate-400">
          {selectedCase
            ? `Selected: ${selectedCase.caseNumber} · ${selectedCase.status}`
            : 'Create or select an investigation in VexaLens before adding records.'}
        </div>
        <label className="flex items-start gap-2 text-xs leading-5 text-slate-300 sm:col-span-2">
          <input
            type="checkbox"
            checked={consentConfirmed}
            onChange={(event) => setConsentConfirmed(event.target.checked)}
            className="mt-1 accent-cyan-500"
          />
          I confirm I am authorized to examine the selected files and record these observations for this case.
        </label>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
        <div className="mb-4 flex items-center gap-2">
          <FileSearch className="h-5 w-5 text-cyan-300" />
          <div>
            <h2 className="font-bold">Hash an investigator-provided artifact</h2>
            <p className="text-xs text-slate-400">The file is read in-browser for SHA-256 calculation only; its contents are not uploaded or saved here.</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs text-slate-300">
            Source app
            <select value={sourceApp} onChange={(event) => setSourceApp(event.target.value as GhostRecoverApp)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
              {SOURCE_APPS.map((app) => <option key={app}>{app}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            Device platform
            <select value={platform} onChange={(event) => setPlatform(event.target.value as GhostRecoverPlatform)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
              <option>Android</option>
              <option>iOS</option>
              <option>Other</option>
            </select>
            <span className="block text-[10px] text-slate-500">Android is primary; iOS records are limited to files you provide.</span>
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            Acquisition description
            <select value={acquisitionMethod} onChange={(event) => setAcquisitionMethod(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
              <option>Investigator-provided export or backup file</option>
              <option>Authorized logical acquisition output</option>
              <option>Investigator-created screenshot or record</option>
              <option>Other authorized source</option>
            </select>
          </label>
        </div>
        <label className="mt-4 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-cyan-800 bg-slate-950 px-4 py-5 text-sm font-semibold text-cyan-200 hover:bg-cyan-950/30">
          <Hash className="h-4 w-4" />
          {busy ? `Processing… ${progress ? `${progress}%` : ''}` : 'Choose a file to hash'}
          <input
            type="file"
            className="sr-only"
            disabled={busy || !selectedCase || !consentConfirmed || !storageLoaded}
            onChange={(event) => void handleImportFile(event)}
          />
        </label>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
        <div className="mb-4 flex items-center gap-2">
          <Clock3 className="h-5 w-5 text-cyan-300" />
          <div>
            <h2 className="font-bold">Record a timeline observation</h2>
            <p className="text-xs text-slate-400">Enter facts observed in authorized records; this does not restore message contents.</p>
          </div>
        </div>
        <form onSubmit={(event) => void handleAddTimelineEvent(event)} className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-300">
            Event time
            <input type="datetime-local" value={eventTime} onChange={(event) => setEventTime(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" required />
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            Event type
            <select value={eventType} onChange={(event) => setEventType(event.target.value as GhostRecoverEventType)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
              {EVENT_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            Source app
            <select value={sourceApp} onChange={(event) => setSourceApp(event.target.value as GhostRecoverApp)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
              {SOURCE_APPS.map((app) => <option key={app}>{app}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-300">
            Participant (optional)
            <input value={participant} onChange={(event) => setParticipant(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" maxLength={120} />
          </label>
          <label className="space-y-1 text-xs text-slate-300 sm:col-span-2">
            Link to a hashed artifact (optional)
            <select value={eventArtifactId} onChange={(event) => setEventArtifactId(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
              <option value="">No linked artifact</option>
              {caseRecord.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.fileName} · {artifact.sha256.slice(0, 12)}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-xs text-slate-300 sm:col-span-2">
            Factual summary
            <textarea value={eventSummary} onChange={(event) => setEventSummary(event.target.value)} className="min-h-20 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" maxLength={2000} placeholder="Describe what the authorized record shows. Avoid entering message content unless needed and authorized." required />
          </label>
          <button type="submit" disabled={busy || !selectedCase || !consentConfirmed || !storageLoaded} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-bold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-2">
            Add timeline observation
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Smartphone className="h-5 w-5 text-cyan-300" />
            <div>
              <h2 className="font-bold">Case record</h2>
              <p className="text-xs text-slate-400">{caseRecord.artifacts.length} artifacts · {caseRecord.timeline.length} timeline entries · {caseRecord.custody.length} custody records</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void handleVerifyChain()} disabled={busy || !selectedCase} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold hover:bg-slate-800 disabled:opacity-50">Verify custody hashes</button>
            <button type="button" onClick={() => void handleDownloadReport()} disabled={busy || !selectedCase} className="inline-flex items-center gap-2 rounded-lg bg-cyan-700 px-3 py-2 text-xs font-bold hover:bg-cyan-600 disabled:opacity-50"><Download className="h-4 w-4" />Download JSON report</button>
          </div>
        </div>

        {custodyCheck && (
          <p role="status" className={`mt-3 rounded-lg p-3 text-xs ${custodyCheck.valid ? 'bg-emerald-950/40 text-emerald-200' : 'bg-rose-950/40 text-rose-200'}`}>
            {custodyCheck.valid
              ? `Custody hash links are consistent across ${custodyCheck.checkedCount} records. This does not prove the browser records were not changed before verification.`
              : `Custody hash verification failed at record ${custodyCheck.invalidIndex === null ? 'unknown' : custodyCheck.invalidIndex + 1}; checked ${custodyCheck.checkedCount} prior records.`}
          </p>
        )}

        <div className="mt-4 space-y-3">
          {caseRecord.artifacts.map((artifact) => (
            <article key={artifact.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="break-all text-slate-200">{artifact.fileName}</strong>
                <span className="text-slate-500">{artifact.sourceApp} · {artifact.platform}</span>
              </div>
              <p className="mt-1 break-all font-mono text-[10px] text-cyan-300">SHA-256: {artifact.sha256}</p>
              <p className="mt-1 text-slate-500">{artifact.acquisitionMethod} · {new Date(artifact.importedAt).toLocaleString()} · {artifact.fileSizeBytes.toLocaleString()} bytes</p>
            </article>
          ))}
          {sortedTimeline.map((item) => (
            <article key={item.id} className="rounded-xl border border-slate-800 bg-slate-950 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <strong className="text-slate-200">{EVENT_TYPES.find((type) => type.value === item.eventType)?.label || item.eventType}</strong>
                <time className="font-mono text-cyan-300">{new Date(item.occurredAt).toLocaleString()}</time>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{item.summary}</p>
              <p className="mt-1 text-[10px] text-slate-500">{item.sourceApp}{item.participant ? ` · ${item.participant}` : ''}{item.artifactId ? ' · linked artifact' : ''}</p>
            </article>
          ))}
          {caseRecord.artifacts.length === 0 && caseRecord.timeline.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">No GhostRecover records for this case yet.</p>
          )}
        </div>
      </section>
    </div>
  );
};
