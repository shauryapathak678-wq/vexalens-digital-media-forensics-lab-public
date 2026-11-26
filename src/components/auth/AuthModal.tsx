import React, { useState, useEffect } from 'react';
import { UserProfile } from '@/types/forensics';
import { ShieldCheck, Check, LogOut, Loader2, AlertCircle, UserPlus } from 'lucide-react';
import {
  signInWithEmail,
  signUpWithEmail,
  requestPasswordReset,
  signOut,
  getAuthUser,
  loadProfile,
  onAuthStateChange,
} from '@/lib/supabase';

interface AuthModalProps {
  isOpen: boolean;
  initialTab?: AuthTab;
  onClose: () => void;
  currentUser: UserProfile;
  onSwitchUser: (newUser: Partial<UserProfile>) => void;
}

type AuthTab = 'switch_role' | 'signin' | 'signup';

export const AuthModal: React.FC<AuthModalProps> = ({
  isOpen,
  initialTab = 'switch_role',
  onClose,
  currentUser,
  onSwitchUser,
}) => {
  const [activeTab, setActiveTab] = useState<AuthTab>(initialTab);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [badgeNumber, setBadgeNumber] = useState('');
  const [agency, setAgency] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [authUser, setAuthUser] = useState<{ id: string; email: string } | null>(null);

  // Check if already signed in with Supabase
  useEffect(() => {
    getAuthUser().then((u) => {
      if (u) setAuthUser({ id: u.id, email: u.email || '' });
    });
    const unsub = onAuthStateChange((_event, session) => {
      if (session?.user) {
        setAuthUser({ id: session.user.id, email: session.user.email || '' });
      } else {
        setAuthUser(null);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (isOpen) setActiveTab(initialTab);
  }, [initialTab, isOpen]);

  if (!isOpen) return null;

  const localProfiles: UserProfile[] = [
    {
      id: 'usr_forensic_01',
      email: 'analyst.chen@cyberforensics.gov',
      fullName: 'Dr. Evelyn Vance',
      badgeNumber: 'DF-9041-A',
      agency: 'Federal Cyber Forensics & Media Integrity Division',
      role: 'lead_analyst',
      createdAt: '2026-01-10T08:00:00Z',
    },
    {
      id: 'usr_forensic_02',
      email: 'investigator.miller@police.gov',
      fullName: 'Det. Marcus Miller',
      badgeNumber: 'FC-4481-B',
      agency: 'State Police Financial Crimes & Digital Evidence Unit',
      role: 'investigator',
      createdAt: '2026-02-15T09:30:00Z',
    },
    {
      id: 'usr_forensic_03',
      email: 'director.reyes@cyberlab.org',
      fullName: 'Director Sarah Reyes',
      badgeNumber: 'DIR-0012',
      agency: 'National Forensic Science Technology Center',
      role: 'administrator',
      createdAt: '2025-11-01T08:00:00Z',
    },
  ];

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    setLoading(true);
    try {
      const { user, error: authErr } = await signInWithEmail(email, password);
      if (authErr) { setError(authErr.message); return; }
      if (user) {
        // Load profile from Supabase and apply it
        const profile = await loadProfile(user.id);
        if (profile) {
          onSwitchUser(profile);
          setSuccessMsg(`Signed in as ${profile.fullName || email}`);
        } else {
          onSwitchUser({ email: user.email || email, id: user.id });
          setSuccessMsg('Signed in, but the Supabase profile could not be loaded. Keep this window open and verify the profile table and role.');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordReset = async () => {
    setError(null);
    setSuccessMsg(null);
    if (!email.trim()) {
      setError('Enter your account email first, then request a password reset.');
      return;
    }

    setLoading(true);
    try {
      const { error: resetError } = await requestPasswordReset(email);
      if (resetError) {
        setError(resetError.message);
      } else {
        setSuccessMsg('If an account exists for that email, Supabase will send a password reset link. Check your inbox and spam folder.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request a password reset.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setLoading(true);
    try {
      const { user, error: authErr } = await signUpWithEmail(email, password, {
        fullName,
        badgeNumber,
        agency,
      });
      if (authErr) { setError(authErr.message); return; }
      if (user) {
        setSuccessMsg('Account created! Check your email to confirm, then sign in.');
        setActiveTab('signin');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    setLoading(true);
    await signOut();
    setAuthUser(null);
    setSuccessMsg('Signed out from Supabase.');
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg bg-slate-900 border border-slate-800 shadow-2xl p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-cyan-400" />
            <h2 className="text-base font-bold text-slate-100">Investigator Authentication</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
        </div>

        {/* Supabase auth status banner */}
        {authUser && (
          <div className="flex items-center justify-between bg-emerald-950/40 border border-emerald-600/30 rounded-lg px-3 py-2 text-xs text-emerald-300">
            <span>✓ Signed in via Supabase: <span className="font-mono">{authUser.email}</span></span>
            <button
              onClick={handleSignOut}
              disabled={loading}
              className="flex items-center gap-1 text-slate-400 hover:text-red-400 ml-3 transition-colors"
              title="Sign out"
            >
              <LogOut className="w-3.5 h-3.5" /> Sign out
            </button>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex rounded bg-slate-950 p-1 border border-slate-800 text-xs gap-1">
          {(['switch_role', 'signin', 'signup'] as AuthTab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setError(null); setSuccessMsg(null); }}
              className={`flex-1 py-1 rounded font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab === 'switch_role' ? 'Role Switch' : tab === 'signin' ? 'Sign In' : 'Sign Up'}
            </button>
          ))}
        </div>

        {/* Error / Success */}
        {error && (
          <div className="flex items-start gap-2 bg-red-950/40 border border-red-600/40 rounded px-3 py-2 text-xs text-red-300">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {error}
          </div>
        )}
        {successMsg && (
          <div className="bg-emerald-950/40 border border-emerald-600/30 rounded px-3 py-2 text-xs text-emerald-300">
            ✓ {successMsg}
          </div>
        )}

        {/* ── Local Role Switch ── */}
        {activeTab === 'switch_role' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              Select a local forensic profile for report signing. For persistent cross-session data, use Sign In.
            </p>
            <div className="space-y-2">
              {localProfiles.map((acc) => {
                const isSelected = currentUser.email === acc.email;
                return (
                  <button
                    key={acc.id}
                    onClick={() => { onSwitchUser(acc); onClose(); }}
                    className={`w-full text-left p-3 rounded-lg border text-xs transition-colors flex items-center justify-between ${
                      isSelected
                        ? 'bg-cyan-950/40 border-cyan-500/60 text-slate-100'
                        : 'bg-slate-950/60 border-slate-800 hover:border-slate-700 text-slate-300'
                    }`}
                  >
                    <div className="space-y-0.5">
                      <div className="font-semibold flex items-center gap-2">
                        <span>{acc.fullName}</span>
                        <span className="font-mono text-[10px] text-cyan-400">[{acc.badgeNumber}]</span>
                      </div>
                      <div className="text-[11px] text-slate-400">{acc.agency}</div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-cyan-400 shrink-0 ml-2" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Sign In ── */}
        {activeTab === 'signin' && (
          <form onSubmit={handleSignIn} className="space-y-3 text-xs">
            <div className="space-y-1">
              <label className="text-slate-400">Email</label>
              <input
                id="signin-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="analyst@forensics.gov"
                className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
              />
            </div>
            <div className="space-y-1">
              <label className="text-slate-400">Password</label>
              <input
                id="signin-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <button
              id="signin-submit"
              type="submit"
              disabled={loading}
              className="w-full py-2 rounded bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-slate-950 font-bold transition-colors shadow-sm flex items-center justify-center gap-2"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Sign In to Forensics Workbench
            </button>
            <p className="text-center text-slate-500">
              No account?{' '}
              <button type="button" className="text-cyan-400 hover:underline" onClick={() => setActiveTab('signup')}>
                Create one
              </button>
            </p>
            <div className="text-center">
              <button
                type="button"
                onClick={handlePasswordReset}
                disabled={loading}
                className="text-cyan-400 hover:underline disabled:opacity-50"
              >
                Forgot password?
              </button>
            </div>
          </form>
        )}

        {/* ── Sign Up ── */}
        {activeTab === 'signup' && (
          <form onSubmit={handleSignUp} className="space-y-3 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1 col-span-2">
                <label className="text-slate-400">Full Name</label>
                <input
                  id="signup-name"
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Dr. Jane Analyst"
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div className="space-y-1 col-span-2">
                <label className="text-slate-400">Email</label>
                <input
                  id="signup-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="analyst@forensics.gov"
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-slate-400">Badge Number</label>
                <input
                  type="text"
                  value={badgeNumber}
                  onChange={(e) => setBadgeNumber(e.target.value)}
                  placeholder="VL-EXAM-001"
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                />
              </div>
              <div className="space-y-1">
                <label className="text-slate-400">Agency</label>
                <input
                  type="text"
                  value={agency}
                  onChange={(e) => setAgency(e.target.value)}
                  placeholder="Cyber Forensics Lab"
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div className="space-y-1 col-span-2">
                <label className="text-slate-400">Password (min 8 chars)</label>
                <input
                  id="signup-password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>
            <button
              id="signup-submit"
              type="submit"
              disabled={loading}
              className="w-full py-2 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 font-bold transition-colors shadow-sm flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              Create Forensics Account
            </button>
            <p className="text-[10px] text-slate-500 text-center">
              Data is stored in Supabase under your authenticated user ID only.
            </p>
          </form>
        )}
      </div>
    </div>
  );
};
