import React, { useMemo, useState } from 'react';
import { Investigation, ShareLink, UserProfile, ShareScope } from '@/types/forensics';
import {
  ShieldCheck,
  Lock,
  Server,
  Trash2,
  Link2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Copy,
  KeyRound,
  FileWarning,
} from 'lucide-react';
import {
  DEFAULT_SHARE_TTL_HOURS,
  buildShareLinkRecord,
  deleteAllShareLinks,
  describeShareStatus,
  getExternalProcessingConsent,
  getShareLinks,
  revokeShareLink,
  saveShareLink,
  setExternalProcessingConsent,
  shareScopeLabel,
} from '@/lib/forensics/sharing';

interface PrivacySharingViewProps {
  user: UserProfile;
  currentCase?: Investigation;
  investigations: Investigation[];
}

const STATUS_STYLES: Record<string, string> = {
  active: 'text-emerald-300 border-emerald-800/70 bg-emerald-950/30',
  expired: 'text-slate-300 border-slate-700 bg-slate-900/60',
  revoked: 'text-rose-300 border-rose-800/70 bg-rose-950/30',
};

export const PrivacySharingView: React.FC<PrivacySharingViewProps> = ({ user, currentCase, investigations }) => {
  const [shareLinks, setShareLinks] = useState<ShareLink[]>(getShareLinks);
  const [consent, setConsent] = useState(getExternalProcessingConsent);
  const [caseId, setCaseId] = useState(currentCase?.id || investigations[0]?.id || '');
  const [scope, setScope] = useState<ShareScope>('report_summary');
  const [ttlHours, setTtlHours] = useState(DEFAULT_SHARE_TTL_HOURS);
  const [consentChecked, setConsentChecked] = useState(false);
  const [error, setError] = useState('');
  const [copiedToken, setCopiedToken] = useState('');

  const activeCount = useMemo(() => shareLinks.filter((link) => describeShareStatus(link) === 'active').length, [shareLinks]);

  const handleCreateShare = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!consentChecked) {
      setError('Explicit consent is required before creating a shareable report.');
      return;
    }
    if (!caseId) {
      setError('Select an investigation to associate with this share link.');
      return;
    }
    const reportId = `RPT-${caseId}-${new Date().toISOString().slice(0, 10)}`;
    const link = buildShareLinkRecord({
      reportId,
      caseId,
      scope,
      createdBy: user.fullName || 'Local Analyst',
      ttlHours,
    });
    const saved = saveShareLink(link);
    setShareLinks(getShareLinks());
    setConsentChecked(false);
    setCopiedToken(saved.token);
  };

  const handleRevoke = (id: string) => {
    revokeShareLink(id, 'Revoked by operator');
    setShareLinks(getShareLinks());
  };

  const handleClearAll = () => {
    deleteAllShareLinks();
    setShareLinks(getShareLinks());
  };

  const handleConsentToggle = (acknowledged: boolean) => {
    const record = setExternalProcessingConsent(acknowledged, user.fullName || 'Local Analyst');
    setConsent(record);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="border-b border-slate-800 pb-4">
        <div className="text-xs font-mono text-cyan-400">PRIVACY · CONSENT · ACCESS CONTROL</div>
        <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-1">Privacy &amp; Report Sharing</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Understand where evidence is processed, control external processing, and manage expiring share links.
        </p>
      </div>

      {/* Data-flow / privacy notice */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <ShieldCheck className="w-4 h-4 text-cyan-400" /> Where your evidence is processed
        </div>
        <ul className="space-y-2 text-xs text-slate-300 leading-relaxed">
          <li className="flex gap-2">
            <Lock className="w-3.5 h-3.5 mt-0.5 text-emerald-400 shrink-0" />
            <span>
              Hashing, metadata inspection, ELA diagnostics, perceptual hashing, signature comparison, and report
              generation run locally in your browser or on the local VexaLens server. Evidence files are not uploaded
              to any third party by these checks.
            </span>
          </li>
          <li className="flex gap-2">
            <Server className="w-3.5 h-3.5 mt-0.5 text-amber-300 shrink-0" />
            <span>
              External AI processing is optional and limited. If a <span className="font-mono">GEMINI_API_KEY</span> is
              configured, the audio transcription feature may send the audio to Google&apos;s Gemini service. If no key
              is configured, transcription is unavailable and no fallback transcript is generated.
            </span>
          </li>
          <li className="flex gap-2">
            <FileWarning className="w-3.5 h-3.5 mt-0.5 text-amber-300 shrink-0" />
            <span>
              Evidence files are never exposed through public URLs by default. Share links created below are local,
              expiring references that must be transferred through a secure channel you control.
            </span>
          </li>
        </ul>
      </section>

      {/* External processing consent */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Server className="w-4 h-4 text-amber-300" /> External processing consent
        </div>
        <p className="text-xs text-slate-400">
          Before any feature that could use an external provider, VexaLens asks for explicit consent. Local checks such
          as hashing, metadata inspection, ELA, and signature comparison never require this.
        </p>
        <label className="flex items-start gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={consent.acknowledged}
            onChange={(e) => handleConsentToggle(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I understand that optional external processing may send the relevant file to a configured external provider,
            and I confirm I am authorised to do so.
          </span>
        </label>
        {consent.acknowledged && consent.acknowledgedAt && (
          <p className="text-[11px] text-emerald-300">
            Consent recorded {new Date(consent.acknowledgedAt).toLocaleString()} by {consent.acknowledgedBy || 'unknown'}.
          </p>
        )}
      </section>

      {/* Create shareable report */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Link2 className="w-4 h-4 text-cyan-400" /> Create an expiring share link
        </div>
        <form onSubmit={handleCreateShare} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Investigation</label>
            <select
              value={caseId}
              onChange={(e) => setCaseId(e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200"
            >
              {investigations.length === 0 && <option value="">No investigations</option>}
              {investigations.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.caseNumber} · {inv.title}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">Scope</label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as ShareScope)}
              className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200"
            >
              <option value="report_summary">Simple report summary</option>
              <option value="full_report">Full forensic report</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              Expires in (hours)
            </label>
            <input
              type="number"
              min={1}
              max={720}
              value={ttlHours}
              onChange={(e) => setTtlHours(Number(e.target.value) || DEFAULT_SHARE_TTL_HOURS)}
              className="w-full bg-slate-950 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-slate-200"
            />
          </div>
          <label className="sm:col-span-3 flex items-start gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              I have authority to share this case&apos;s report data and consent to creating an expiring, access-controlled
              share link. Sensitive personal data should be removed unless strictly necessary.
            </span>
          </label>
          {error && (
            <p role="alert" className="sm:col-span-3 flex items-center gap-1.5 text-xs text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </p>
          )}
          <div className="sm:col-span-3">
            <button
              type="submit"
              className="px-4 py-2 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold transition-colors"
            >
              Create share link
            </button>
          </div>
        </form>

        {copiedToken && (
          <div className="flex items-start gap-2 p-3 rounded bg-emerald-950/25 border border-emerald-900/60 text-[11px] text-emerald-200">
            <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p>Share token (local reference, not a public URL):</p>
              <div className="flex items-center gap-2">
                <code className="font-mono break-all">{copiedToken}</code>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(copiedToken)}
                  className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200"
                >
                  <Copy className="w-3 h-3" /> Copy
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Share link list */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Clock className="w-4 h-4 text-cyan-400" /> Share links ({activeCount} active)
          </div>
          {shareLinks.length > 0 && (
            <button
              onClick={handleClearAll}
              className="inline-flex items-center gap-1.5 text-xs text-rose-300 hover:text-rose-200"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete all
            </button>
          )}
        </div>
        {shareLinks.length === 0 ? (
          <div className="py-8 text-center text-xs text-slate-500">No share links have been created.</div>
        ) : (
          <ul className="divide-y divide-slate-800/70">
            {shareLinks.map((link) => {
              const status = describeShareStatus(link);
              return (
                <li key={link.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded border text-[10px] font-mono uppercase ${STATUS_STYLES[status]}`}>
                        {status}
                      </span>
                      <span className="text-slate-200 font-medium">{shareScopeLabel(link.scope)}</span>
                    </div>
                    <div className="font-mono text-slate-400">
                      Report {link.reportId} · token {link.token.slice(0, 8)}…
                    </div>
                    <div className="text-slate-500">
                      Created {new Date(link.createdAt).toLocaleString()} · expires{' '}
                      {new Date(link.expiresAt).toLocaleString()}
                    </div>
                  </div>
                  {status === 'active' && (
                    <button
                      onClick={() => handleRevoke(link.id)}
                      className="self-start sm:self-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-rose-800/70 text-rose-300 hover:bg-rose-950/40 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Revoke
                    </button>
                  )}
                  {status !== 'active' && (
                    <span className="inline-flex items-center gap-1.5 text-slate-500">
                      <CheckCircle2 className="w-3.5 h-3.5" /> No longer usable
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Retention */}
      <section className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 text-[11px] text-slate-400 space-y-1">
        <div className="flex items-center gap-2 text-slate-300 font-medium">
          <Lock className="w-3.5 h-3.5 text-cyan-400" /> Retention &amp; deletion
        </div>
        <p>
          Authorised evidence deletion is available in Case Management and Settings. Deleting evidence also removes its
          associated findings, provenance events, certificates, and share links should you clear them here. API keys are
          stored only in server environment variables and are never exposed to the browser.
        </p>
      </section>
    </div>
  );
};
