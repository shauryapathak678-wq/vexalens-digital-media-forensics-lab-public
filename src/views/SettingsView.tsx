import React, { useState, useEffect } from 'react';
import { UserProfile } from '@/types/forensics';
import {
  getSupabaseConfig,
  saveSupabaseConfig,
  testSupabaseConnection,
  isSupabaseConfigured,
  getSupabaseConnectionStatus,
} from '@/lib/supabase';
import { isPuterAvailable, requestPuterAccountSwitch } from '@/lib/forensics/puterAiDetector';
import {
  fetchSightengineCredentialsStatus,
  updateSightengineCredentials,
  type SightengineCredentialsStatus,
} from '@/lib/forensics/sightengineDeepfake';
import { removeDemoData, resetToSampleData } from '@/lib/storage';
import {
  Sliders,
  User,
  Database,
  RefreshCcw,
  CheckCircle2,
  AlertCircle,
  FileCode,
  ShieldCheck,
  Save,
  RefreshCw,
  ScanEye,
  Key,
  ExternalLink,
} from 'lucide-react';

interface SettingsViewProps {
  user: UserProfile;
  onUpdateUser: (updates: Partial<UserProfile>) => void;
  onDataReset: () => void;
  onOpenServices: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  user,
  onUpdateUser,
  onDataReset,
  onOpenServices,
}) => {
  // Profile state
  const [fullName, setFullName] = useState(user.fullName);
  const [badgeNumber, setBadgeNumber] = useState(user.badgeNumber);
  const [agency, setAgency] = useState(user.agency);
  const [role, setRole] = useState(user.role);
  const [profileSaved, setProfileSaved] = useState(false);

  // Supabase state
  const config = getSupabaseConfig();
  const [supabaseUrl, setSupabaseUrl] = useState(config.url);
  const [supabaseKey, setSupabaseKey] = useState(config.anonKey);
  const [supabaseConfigError, setSupabaseConfigError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success?: boolean; message?: string } | null>(() => {
    const saved = getSupabaseConnectionStatus();
    if (saved.status === 'passed') return { success: true, message: `Read-only database query passed${saved.checkedAt ? ` at ${new Date(saved.checkedAt).toLocaleString()}` : ''}.` };
    if (saved.status === 'failed') return { success: false, message: `The last read-only connection test failed${saved.checkedAt ? ` at ${new Date(saved.checkedAt).toLocaleString()}` : ''}.` };
    return null;
  });
  const [isTesting, setIsTesting] = useState(false);
  const [puterAvailable] = useState(() => isPuterAvailable());
  const [puterAccountBusy, setPuterAccountBusy] = useState(false);
  const [puterAccountMessage, setPuterAccountMessage] = useState<string | null>(null);

  // Sightengine API state
  const [sightengineStatus, setSightengineStatus] = useState<SightengineCredentialsStatus>({
    configured: true,
    hasUser: true,
    hasSecret: true,
    maskedUser: '78...46',
    maskedSecret: 'mXMk...fbNW',
  });
  const [sightengineUser, setSightengineUser] = useState('781876146');
  const [sightengineSecret, setSightengineSecret] = useState('mXMktafFVLZHinCiVsN6F4ymKaodfbNW');
  const [sightengineSaving, setSightengineSaving] = useState(false);
  const [sightengineMessage, setSightengineMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchSightengineCredentialsStatus()
      .then((status) => {
        setSightengineStatus(status);
        if (status.maskedUser) setSightengineUser(status.maskedUser);
      })
      .catch(() => {});
  }, []);

  const handleSaveSightengine = async (e: React.FormEvent) => {
    e.preventDefault();
    setSightengineSaving(true);
    setSightengineMessage(null);
    try {
      const res = await updateSightengineCredentials(sightengineUser.trim(), sightengineSecret.trim());
      const updated = await fetchSightengineCredentialsStatus();
      setSightengineStatus(updated);
      setSightengineMessage(res.message || 'Sightengine credentials saved successfully.');
    } catch (err) {
      setSightengineMessage(err instanceof Error ? err.message : 'Failed to save credentials.');
    } finally {
      setSightengineSaving(false);
    }
  };

  const handleSwitchPuterAccount = async () => {
    setPuterAccountBusy(true);
    setPuterAccountMessage(null);
    try {
      await requestPuterAccountSwitch();
      setPuterAccountMessage('Puter sign-in completed. Confirm the account in the sign-in window.');
    } catch (error) {
      setPuterAccountMessage(error instanceof Error ? error.message : 'Puter account switching failed.');
    } finally {
      setPuterAccountBusy(false);
    }
  };

  const handleSaveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateUser({
      fullName: fullName.trim(),
      badgeNumber: badgeNumber.trim(),
      agency: agency.trim(),
      role,
    });
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2500);
  };

  const handleSaveSupabase = () => {
    try {
      saveSupabaseConfig(supabaseUrl, supabaseKey);
      setSupabaseConfigError(null);
      setTestResult(null);
      alert('Supabase publishable credentials saved.');
    } catch (err) {
      setSupabaseConfigError(err instanceof Error ? err.message : 'Could not save Supabase configuration.');
    }
  };

  const handleTestSupabase = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      saveSupabaseConfig(supabaseUrl, supabaseKey);
      setSupabaseConfigError(null);
      const res = await testSupabaseConnection();
      setTestResult(res);
    } catch (err) {
      setSupabaseConfigError(err instanceof Error ? err.message : 'Could not test Supabase configuration.');
    } finally {
      setIsTesting(false);
    }
  };

  const handleResetData = () => {
    if (
      window.confirm(
        'Are you sure you want to restore the demonstration database? All sample cases, evidence, and ELA scans will be refreshed.'
      )
    ) {
      resetToSampleData();
      onDataReset();
      alert('Forensics lab database restored to factory demo state.');
    }
  };

  const handleRemoveDemoData = () => {
    if (window.confirm('Remove only the seeded demonstration cases, evidence, findings, provenance events, activity, certificates, and demo profile? Other locally stored records will be kept.')) {
      removeDemoData();
      onDataReset();
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="border-b border-slate-800 pb-4">
        <div className="text-xs font-mono text-cyan-400">LAB WORKBENCH CONFIGURATION</div>
        <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-1">
          Forensics Lab Settings & System Integrations
        </h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Investigator Credentials */}
        <div className="p-5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
            <User className="w-4 h-4 text-cyan-400" />
            <span>Investigator Credentials & Agency Attestation</span>
          </div>

          <form onSubmit={handleSaveProfile} className="space-y-3 text-xs">
            <div className="space-y-1">
              <label className="text-slate-400">Examiner Full Name</label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-slate-400">Badge / Warrant #</label>
                <input
                  type="text"
                  required
                  value={badgeNumber}
                  onChange={(e) => setBadgeNumber(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-400">Investigator Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                >
                  <option value="lead_analyst">Lead Forensic Analyst</option>
                  <option value="investigator">Digital Media Investigator</option>
                  <option value="administrator">Lab Director / Admin</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-slate-400">Agency / Institutional Division</label>
              <input
                type="text"
                required
                value={agency}
                onChange={(e) => setAgency(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div className="flex items-center justify-between pt-2">
              {profileSaved ? (
                <span className="text-emerald-400 font-medium flex items-center gap-1 text-[11px]">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Updated Attestation Profile
                </span>
              ) : <div />}

              <button
                type="submit"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-semibold transition-colors shadow-sm"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Profile</span>
              </button>
            </div>
          </form>
        </div>

        {/* Forensic Services Center entry */}
        <div className="p-5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-4 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
              <ShieldCheck className="w-4 h-4 text-cyan-400" />
              <span>Forensic Services Center</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">Inspect live server self-tests, browser ELA/PDF smoke tests, configured integrations, and unavailable specialist models.</p>
            <button type="button" onClick={onOpenServices} className="w-full px-3 py-2 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold">Open Forensic Services Center</button>
          </div>

          <div className="pt-3 border-t border-slate-800">
            <button
              onClick={handleRemoveDemoData}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 mb-2 rounded bg-amber-950/50 hover:bg-amber-900/60 text-xs text-amber-200 transition-colors"
            >
              <AlertCircle className="w-3.5 h-3.5" />
              <span>Remove Demonstration Records</span>
            </button>
            <button
              onClick={handleResetData}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 transition-colors"
            >
              <RefreshCcw className="w-3.5 h-3.5 text-amber-400" />
              <span>Reset Data to Factory Demonstration State</span>
            </button>
          </div>
        </div>
      </div>

      <section className="p-5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
          <RefreshCw className="w-4 h-4 text-violet-400" />
          <span>Puter Account</span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          Switch the Puter account used by the image-assessment integration. Video detection uses TruthScan and does not depend on Puter.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleSwitchPuterAccount()}
            disabled={!puterAvailable || puterAccountBusy}
            className="inline-flex items-center gap-1.5 rounded bg-slate-800 hover:bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${puterAccountBusy ? 'animate-spin' : ''}`} />
            {puterAccountBusy ? 'Opening Puter sign-in…' : 'Switch Puter account'}
          </button>
          {!puterAvailable && <span className="text-xs text-amber-300">Puter.js is unavailable. Check internet access and reload the app.</span>}
          {puterAccountMessage && <p role="status" className="text-xs text-slate-300">{puterAccountMessage}</p>}
        </div>
      </section>

      {/* Sightengine Deepfake Forensics Configuration */}
      <section className="p-5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
            <ScanEye className="w-4 h-4 text-cyan-400" />
            <span>Sightengine Facial Deepfake & Video Detector</span>
          </div>

          <span
            className={`text-xs px-2 py-0.5 rounded font-mono ${
              sightengineStatus?.configured
                ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                : sightengineStatus?.hasSecret
                ? 'bg-amber-950 text-amber-300 border border-amber-800'
                : 'bg-slate-800 text-slate-400'
            }`}
          >
            {sightengineStatus?.configured
              ? `Connected · User ${sightengineStatus.maskedUser}`
              : sightengineStatus?.hasSecret
              ? 'API Secret configured · API User ID required'
              : 'Not configured'}
          </span>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Powers facial manipulation, deepfake detection, and AI-generated video analysis in the{' '}
          <b>AI Video & Deepfake Lab</b>. Sightengine requires both your numeric <b>API User ID</b> and 32-character <b>API Secret</b> from your{' '}
          <a
            href="https://dashboard.sightengine.com/api-credentials"
            target="_blank"
            rel="noreferrer"
            className="text-cyan-400 hover:underline inline-flex items-center gap-0.5"
          >
            Sightengine API Dashboard <ExternalLink className="w-2.5 h-2.5" />
          </a>.
        </p>

        <form onSubmit={handleSaveSightengine} className="space-y-3 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-slate-400">SIGHTENGINE_API_USER (numeric ID)</label>
              <input
                type="text"
                placeholder="e.g. 1049281729"
                value={sightengineUser}
                onChange={(e) => setSightengineUser(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-400">SIGHTENGINE_API_SECRET</label>
              <input
                type="password"
                placeholder="32-character API secret"
                value={sightengineSecret}
                onChange={(e) => setSightengineSecret(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              type="submit"
              disabled={sightengineSaving}
              className="inline-flex items-center gap-1.5 py-1.5 px-3 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs disabled:opacity-50 transition"
            >
              <Save className="w-3.5 h-3.5" />
              {sightengineSaving ? 'Saving...' : 'Save Sightengine Credentials'}
            </button>
            {sightengineMessage && (
              <span className="text-xs text-emerald-300 font-mono">{sightengineMessage}</span>
            )}
          </div>
        </form>
      </section>

      {/* Supabase Integration Configuration */}
      <div className="p-5 rounded-lg bg-slate-900/60 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
            <Database className="w-4 h-4 text-cyan-400" />
            <span>Supabase Connection Test</span>
          </div>

          <span
            className={`text-xs px-2 py-0.5 rounded font-mono ${testResult?.success ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : isSupabaseConfigured() ? 'bg-amber-950 text-amber-300 border border-amber-800' : 'bg-slate-800 text-slate-400'}`}
          >
            {testResult?.success ? 'Connection test passed' : testResult?.success === false ? 'Connection test failed' : isSupabaseConfigured() ? 'Credentials configured · unverified' : 'Local Storage Mode'}
          </span>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Use a Supabase publishable key (or legacy anon key) only. Secret and service-role keys are rejected because browser code cannot safely store them.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="space-y-1">
            <label className="text-slate-400">SUPABASE_URL</label>
            <input
              type="text"
              value={supabaseUrl}
              onChange={(e) => setSupabaseUrl(e.target.value)}
              placeholder="https://your-project.supabase.co"
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div className="space-y-1">
            <label className="text-slate-400">SUPABASE_PUBLISHABLE_KEY</label>
            <input
              type="password"
              value={supabaseKey}
              onChange={(e) => setSupabaseKey(e.target.value)}
              placeholder="eyJhbGciOiJIUzI1NiIsIn..."
              className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-1.5 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
            />
          </div>
        </div>

        {supabaseConfigError && (
          <div className="p-3 rounded text-xs flex items-center gap-2 bg-rose-950/30 border border-rose-800/60 text-rose-300">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{supabaseConfigError}</span>
          </div>
        )}

        {testResult && (
          <div
            className={`p-3 rounded text-xs flex items-center gap-2 ${
              testResult.success
                ? 'bg-emerald-950/30 border border-emerald-800/60 text-emerald-300'
                : 'bg-rose-950/30 border border-rose-800/60 text-rose-300'
            }`}
          >
            {testResult.success ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            )}
            <span>{testResult.message}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
            <FileCode className="w-3.5 h-3.5 text-cyan-400" />
            <span>Migration script: supabase/migrations/20261015_initial_forensic_schema.sql</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveSupabase}
              className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 transition-colors"
            >
              Save Credentials
            </button>
            <button
              onClick={handleTestSupabase}
              disabled={isTesting}
              className="px-3.5 py-1.5 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-semibold transition-colors disabled:opacity-50"
            >
              {isTesting ? 'Testing Connection...' : 'Test Connection'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
