/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useState, useEffect, useCallback, useRef } from 'react';
import {
  Investigation,
  EvidenceItem,
  EvidenceMetadata,
  AnalysisFinding,
  ProvenanceEvent,
  ActivityLog,
  UserProfile,
  CaseStatus,
} from '@/types/forensics';
import {
  getCurrentUser,
  updateCurrentUser,
  getInvestigations,
  getInvestigation,
  createInvestigation,
  updateInvestigation,
  deleteInvestigation,
  getEvidenceItems,
  addEvidenceItem,
  updateEvidenceItem,
  updateEvidenceThumbnail,
  deleteEvidenceItem,
  getFindings,
  addFinding,
  deleteFinding,
  getProvenanceEvents,
  addProvenanceEvent,
  getActivityLogs,
  logActivity,
  getCertificates,
  removeLocalInvestigation,
  saveCertificate,
  revokeCertificate,
  removeDemoData,
  replaceLocalInvestigationCache,
  replaceLocalEvidenceCache,
} from '@/lib/storage';
import { isSupabaseConfigured, onAuthStateChange, getAuthUser, getAuthSession, loadProfile } from '@/lib/supabase';
import { calculateEvidenceHashes } from '@/lib/forensics/crypto';
import {
  syncFetchInvestigations,
  syncFetchEvidenceItems,
  syncFetchFindings,
  syncFetchProvenanceEvents,
  syncFetchActivityLogs,
  syncAddEvidenceItem,
  syncUpdateEvidenceMetadata,
  syncUpdateEvidenceThumbnail,
  syncEnsureInvestigation,
  syncUpdateInvestigation,
  syncDeleteInvestigation,
} from '@/lib/supabase-sync';
import { EvidenceCertificate } from '@/types/forensics';

// Layout Components
import { Header } from '@/components/layout/Header';
import { Sidebar, NavTab, ExperienceMode } from '@/components/layout/Sidebar';
import { AuthModal } from '@/components/auth/AuthModal';

import { CommandPalette } from '@/components/common/CommandPalette';

// Views
import type { PortalSection } from '@/views/MainPortalView';

const LandingView = lazy(() => import('@/views/LandingView').then((module) => ({ default: module.LandingView })));
const MainPortalView = lazy(() => import('@/views/MainPortalView').then((module) => ({ default: module.MainPortalView })));
const AdminView = lazy(() => import('@/views/AdminView').then((module) => ({ default: module.AdminView })));
const EvidenceRoomView = lazy(() => import('@/views/EvidenceRoomView').then((module) => ({ default: module.EvidenceRoomView })));
const GhostRecoverView = lazy(() => import('@/views/GhostRecoverView').then((module) => ({ default: module.GhostRecoverView })));
const InvestigationsView = lazy(() => import('@/views/InvestigationsView').then((module) => ({ default: module.InvestigationsView })));
const EvidenceUploadView = lazy(() => import('@/views/EvidenceUploadView').then((module) => ({ default: module.EvidenceUploadView })));
const BatchInvestigationView = lazy(() => import('@/views/BatchInvestigationView').then((module) => ({ default: module.BatchInvestigationView })));
const CaseRelationshipView = lazy(() => import('@/views/CaseRelationshipView').then((module) => ({ default: module.CaseRelationshipView })));
const ImageForensicsView = lazy(() => import('@/views/ImageForensicsView').then((module) => ({ default: module.ImageForensicsView })));
const VideoForensicsView = lazy(() => import('@/views/VideoForensicsView').then((module) => ({ default: module.VideoForensicsView })));
const LipSyncInvestigatorView = lazy(() => import('@/views/LipSyncInvestigatorView').then((module) => ({ default: module.LipSyncInvestigatorView })));
const AudioForensicsView = lazy(() => import('@/views/AudioForensicsView').then((module) => ({ default: module.AudioForensicsView })));
const DeepfakeDetectorView = lazy(() => import('@/views/DeepfakeDetectorView').then((module) => ({ default: module.DeepfakeDetectorView })));
const MediaComparisonView = lazy(() => import('@/views/MediaComparisonView').then((module) => ({ default: module.MediaComparisonView })));
const ProvenanceTimelineView = lazy(() => import('@/views/ProvenanceTimelineView').then((module) => ({ default: module.ProvenanceTimelineView })));
const CertificatesView = lazy(() => import('@/views/CertificatesView').then((module) => ({ default: module.CertificatesView })));
const FindingsView = lazy(() => import('@/views/FindingsView').then((module) => ({ default: module.FindingsView })));
const ReportsView = lazy(() => import('@/views/ReportsView').then((module) => ({ default: module.ReportsView })));
const HistoryRoomView = lazy(() => import('@/views/HistoryRoomView').then((module) => ({ default: module.HistoryRoomView })));
const PrivacySharingView = lazy(() => import('@/views/PrivacySharingView').then((module) => ({ default: module.PrivacySharingView })));
const SettingsView = lazy(() => import('@/views/SettingsView').then((module) => ({ default: module.SettingsView })));
const ForensicServicesView = lazy(() => import('@/views/ForensicServicesView').then((module) => ({ default: module.ForensicServicesView })));
const AIOriginAssessmentView = lazy(() => import('@/views/AIOriginAssessmentView').then((module) => ({ default: module.AIOriginAssessmentView })));
const SignatureCompareView = lazy(() => import('@/views/SignatureCompareView').then((module) => ({ default: module.SignatureCompareView })));
const PhotoToVideoMatchView = lazy(() => import('@/views/PhotoToVideoMatchView').then((module) => ({ default: module.PhotoToVideoMatchView })));
const BackendProcessingView = lazy(() => import('@/views/BackendProcessingView').then((module) => ({ default: module.BackendProcessingView })));
const AIModelStatusView = lazy(() => import('@/views/AIModelStatusView').then((module) => ({ default: module.AIModelStatusView })));
const MediaOriginIntelligenceView = lazy(() => import('@/views/MediaOriginIntelligenceView').then((module) => ({ default: module.MediaOriginIntelligenceView })));
const InformationView = lazy(() => import('@/views/InformationView').then((module) => ({ default: module.InformationView })));
const DocumentForensicsView = lazy(() => import('@/views/DocumentForensicsView').then((module) => ({ default: module.DocumentForensicsView })));
const ScreenshotDetectorView = lazy(() => import('@/views/ScreenshotDetectorView').then((module) => ({ default: module.ScreenshotDetectorView })));
const EmailVerifierView = lazy(() => import('@/views/EmailVerifierView').then((module) => ({ default: module.EmailVerifierView })));
const SteganographyDetectorView = lazy(() => import('@/views/SteganographyDetectorView').then((module) => ({ default: module.SteganographyDetectorView })));
const GpsImageTrackerView = lazy(() => import('@/views/GpsImageTracker').then((module) => ({ default: module.GpsImageTracker })));

function PageLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-6 text-sm text-slate-400" role="status" aria-live="polite">
      Loading workspace…
    </div>
  );
}

const AUTH_PROFILE_CHECK_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

const TAB_PATHS: Record<NavTab, string> = {
  landing: '/',
  information: '/information',
  workspaces: '/workspaces',
  dashboard: '/workspaces',
  admin: '/workspaces/admin',
  evidence_room: '/workspaces/evidence-room',
  ghost_recover: '/workspaces/evidence-room/ghost-recover',
  investigations: '/workspaces/admin/cases',
  upload: '/workspaces/lab',
  screenshot_detector: '/workspaces/lab/screenshot-detector',
  email_verifier: '/workspaces/lab/email-verifier',
  document_forensics: '/workspaces/lab/document-forensics',
  image_forensics: '/workspaces/lab/image-forensics',
  image_trace: '/workspaces/lab/image-trace',
  gps_image_tracker: '/workspaces/lab/gps-image-tracker',
  ai_origin: '/workspaces/lab/ai-origin',
  video_forensics: '/workspaces/lab/video-forensics',
  lip_sync: '/workspaces/lab/lip-sync',
  deepfake: '/workspaces/lab/deepfake',
  photo_video_match: '/workspaces/lab/photo-video-match',
  signature_compare: '/workspaces/lab/signature-comparison',
  audio_forensics: '/workspaces/lab/audio-forensics',
  metadata_inspector: '/workspaces/lab/metadata',
  origin_intelligence: '/workspaces/lab/origin-intelligence',
  steganography_detector: '/workspaces/lab/steganography-detector',
  comparison: '/workspaces/lab/media-comparison',
  backend_processing: '/workspaces/admin/backend-processing',
  ai_model_status: '/workspaces/admin/ai-status',
  services: '/workspaces/admin/services',
  chain_of_custody: '/workspaces/evidence-room/chain-of-custody',
  timeline: '/workspaces/evidence-room/timeline',
  batch: '/workspaces/lab/batch',
  case_relationships: '/workspaces/admin/case-relationships',
  certificates: '/workspaces/evidence-room/certificates',
  findings: '/workspaces/history-room/findings',
  reports: '/workspaces/history-room/reports',
  history_room: '/workspaces/history-room',
  privacy: '/workspaces/admin/privacy',
  settings: '/workspaces/admin/settings',
};

const getTabFromPath = (pathname: string): NavTab | undefined =>
  (Object.keys(TAB_PATHS) as NavTab[]).find(
    (tab) => tab !== 'dashboard' && TAB_PATHS[tab] === pathname
  );

export default function App() {
  const [currentTab, setCurrentTabState] = useState<NavTab>(
    () => getTabFromPath(window.location.pathname) ?? 'landing'
  );
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>(() =>
    localStorage.getItem('vexalens_experience_mode') === 'expert' ? 'expert' : 'beginner'
  );
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [authInitialTab, setAuthInitialTab] = useState<'switch_role' | 'signin' | 'signup'>('switch_role');
  const [isAuthProfileLoaded, setIsAuthProfileLoaded] = useState(false);
  const [isAdministratorVerified, setIsAdministratorVerified] = useState(false);
  const [adminAccessMessage, setAdminAccessMessage] = useState('');
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Theme Management (Dark & Light)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('vexalens_theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(theme);
    localStorage.setItem('vexalens_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // Keyboard shortcut for Command Palette (Ctrl+K / Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // App state
  const [user, setUser] = useState<UserProfile>(getCurrentUser());
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [currentCase, setCurrentCase] = useState<Investigation | undefined>(undefined);
  const [evidenceList, setEvidenceList] = useState<EvidenceItem[]>([]);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceItem | undefined>(undefined);
  const [requestedDocumentAnalysisId, setRequestedDocumentAnalysisId] = useState<string | undefined>(undefined);
  const [findings, setFindings] = useState<AnalysisFinding[]>([]);
  const [provenanceEvents, setProvenanceEvents] = useState<ProvenanceEvent[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [certificates, setCertificates] = useState<EvidenceCertificate[]>([]);
  const supabaseLoadInFlightRef = useRef<Promise<void> | null>(null);
  const hasDemoData = false;

  const refreshAuthenticatedProfile = useCallback(async () => {
    const authUser = await withTimeout(
      getAuthUser(),
      AUTH_PROFILE_CHECK_TIMEOUT_MS,
      'Supabase administrator verification timed out. Check your connection and try again.',
    );
    if (!authUser) {
      throw new Error('No Supabase user is signed in. Sign in with the account whose profile was updated.');
    }
    const profile = await withTimeout(
      loadProfile(authUser.id),
      AUTH_PROFILE_CHECK_TIMEOUT_MS,
      'Supabase profile verification timed out. Check your connection and try again.',
    );
    if (!profile) {
      throw new Error(`Could not load the Supabase profile for ${authUser.email || 'the signed-in account'}.`);
    }
    const updated = updateCurrentUser(profile);
    setUser(updated);
    setIsAdministratorVerified(profile.role === 'administrator');
    setIsAuthProfileLoaded(true);
    return { email: authUser.email || profile.email, role: profile.role };
  }, []);

  const handleRefreshProfileAccess = async (): Promise<string> => {
    try {
      const profile = await refreshAuthenticatedProfile();
      return `Loaded Supabase profile ${profile.email} with role "${profile.role}".`;
    } catch (err) {
      return err instanceof Error ? err.message : 'Could not refresh the Supabase profile.';
    }
  };

  const setCurrentTab = (requestedTab: NavTab) => {
    const nextTab = requestedTab === 'dashboard' ? 'workspaces' : requestedTab;
    const restricted = nextTab === 'admin' || nextTab === 'investigations' || nextTab === 'case_relationships';
    const destination = restricted && !isAdministratorVerified ? 'workspaces' : nextTab;
    const path = TAB_PATHS[destination];
    if (window.location.pathname !== path) {
      window.history.pushState({ tab: destination }, '', path);
    }
    setCurrentTabState(destination);
  };

  useEffect(() => {
    const syncRoute = () => {
      const routeTab = getTabFromPath(window.location.pathname);
      if (!routeTab) {
        window.history.replaceState({ tab: 'landing' }, '', '/');
        setCurrentTabState('landing');
        return;
      }
      const restrictedRoute = routeTab === 'admin' || routeTab === 'investigations' || routeTab === 'case_relationships';
      if (restrictedRoute && !isAuthProfileLoaded) {
        setCurrentTabState(routeTab);
        return;
      }
      setCurrentTabState(routeTab);
    };
    window.addEventListener('popstate', syncRoute);
    syncRoute();
    return () => window.removeEventListener('popstate', syncRoute);
  }, [isAuthProfileLoaded, isAdministratorVerified]);

  // Enforce Real Data Mode on Mount: Purge all demo datasets
  useEffect(() => {
    removeDemoData();
    const invs = getInvestigations();
    setInvestigations(invs);
    setCurrentCase(invs[0]);

    const evs = getEvidenceItems();
    setEvidenceList(evs);
    setSelectedEvidence(evs[0]);
    setFindings(getFindings());
    setProvenanceEvents(getProvenanceEvents());
    setActivityLogs(getActivityLogs());
    setCertificates(getCertificates());
  }, []);

  // Subscribe to Supabase auth state — load from DB when signed in, fall back to localStorage
  useEffect(() => {
    let disposed = false;
    let authRevision = 0;

    const applySession = async (authUserId: string, revision: number) => {
      try {
        const profile = await withTimeout(
          loadProfile(authUserId),
          AUTH_PROFILE_CHECK_TIMEOUT_MS,
          'Supabase profile verification timed out. Check your connection and try again.',
        );
        if (disposed || revision !== authRevision) return;
        if (profile) {
          setUser(profile);
          setIsAdministratorVerified(profile.role === 'administrator');
        } else {
          setIsAdministratorVerified(false);
        }
        setIsAuthProfileLoaded(true);
        await loadFromSupabase();
      } catch (error) {
        if (disposed || revision !== authRevision) return;
        console.error('[Auth] Could not load Supabase session profile:', error);
        setIsAdministratorVerified(false);
        setIsAuthProfileLoaded(true);
        setAdminAccessMessage(error instanceof Error ? error.message : 'Could not verify Supabase administrator access.');
      }
    };

    const unsub = onAuthStateChange((event, session) => {
      if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT' && event !== 'INITIAL_SESSION') return;
      const revision = ++authRevision;
      if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {
        setAdminAccessMessage('');
        setIsAuthProfileLoaded(false);
        queueMicrotask(() => {
          void applySession(session.user.id, revision);
        });
      } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') {
        setIsAdministratorVerified(false);
        setIsAuthProfileLoaded(true);
        if (event === 'SIGNED_OUT') {
          setAdminAccessMessage('');
          refreshState();
        }
      }
    });

    const initialRevision = authRevision;
    withTimeout(
      getAuthUser(),
      AUTH_PROFILE_CHECK_TIMEOUT_MS,
      'Supabase administrator verification timed out. Check your connection and try again.',
    )
      .then((authUser) => {
        if (disposed || initialRevision !== authRevision) return;
        if (!authUser) {
          setIsAdministratorVerified(false);
          setIsAuthProfileLoaded(true);
          return;
        }
        void applySession(authUser.id, initialRevision);
      })
      .catch((error: unknown) => {
        if (disposed || initialRevision !== authRevision) return;
        console.error('[Auth] Could not initialize Supabase profile:', error);
        setIsAdministratorVerified(false);
        setIsAuthProfileLoaded(true);
        setAdminAccessMessage(error instanceof Error ? error.message : 'Could not verify Supabase administrator access.');
      });

    let lastVisibilityRefreshAt = 0;
    const refreshDatabaseWhenVisible = () => {
      const now = Date.now();
      if (document.visibilityState !== 'visible' || now - lastVisibilityRefreshAt < 5 * 60_000) return;
      lastVisibilityRefreshAt = now;
      void getAuthSession()
        .then((session) => session ? refreshAuthenticatedProfile() : null)
        .then((profile) => profile ? loadFromSupabase() : undefined)
        .catch((error: unknown) => {
          console.error('[Auth] Could not refresh Supabase data on focus:', error);
        });
    };
    window.addEventListener('focus', refreshDatabaseWhenVisible);
    document.addEventListener('visibilitychange', refreshDatabaseWhenVisible);

    return () => {
      disposed = true;
      window.removeEventListener('focus', refreshDatabaseWhenVisible);
      document.removeEventListener('visibilitychange', refreshDatabaseWhenVisible);
      unsub();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load all data from Supabase when authenticated
  const loadFromSupabase = async () => {
    if (supabaseLoadInFlightRef.current) return supabaseLoadInFlightRef.current;
    const loadPromise = (async () => {
      const [remoteInvs, remoteEvs, remoteFindings, remoteProvenance, remoteLogs] =
        await Promise.all([
          syncFetchInvestigations(),
          syncFetchEvidenceItems(),
          syncFetchFindings(),
          syncFetchProvenanceEvents(),
          syncFetchActivityLogs(),
        ]);

      const invs = remoteInvs ?? getInvestigations();
      if (remoteInvs !== null) replaceLocalInvestigationCache(invs);
      setInvestigations(invs);
      setCurrentCase((prev) => invs.find((i) => i.id === prev?.id) ?? invs[0]);
      if (remoteInvs === null) {
        console.error('[Sync] Supabase investigations could not be loaded; local cases are not shown as if they were shared.');
      }
      if (remoteEvs !== null) {
        replaceLocalEvidenceCache(remoteEvs);
        setEvidenceList(remoteEvs);
        setSelectedEvidence((prev) => remoteEvs.find((e) => e.id === prev?.id) ?? remoteEvs[0]);
      }
      if (remoteFindings !== null) setFindings(remoteFindings);
      if (remoteProvenance !== null) setProvenanceEvents(remoteProvenance);
      if (remoteLogs !== null) setActivityLogs(remoteLogs);
    })();
    supabaseLoadInFlightRef.current = loadPromise;
    try {
      await loadPromise;
    } finally {
      if (supabaseLoadInFlightRef.current === loadPromise) {
        supabaseLoadInFlightRef.current = null;
      }
    }
  };

  // Refresh all state from storage
  const refreshState = () => {
    setUser(getCurrentUser());
    const invs = getInvestigations();
    setInvestigations(invs);
    setCurrentCase(currentCase ? invs.find((item) => item.id === currentCase.id) || invs[0] : invs[0]);
    const evs = getEvidenceItems();
    setEvidenceList(evs);
    if (!selectedEvidence || !evs.some((e) => e.id === selectedEvidence.id)) {
      setSelectedEvidence(evs[0]);
    }
    setFindings(getFindings());
    setProvenanceEvents(getProvenanceEvents());
    setActivityLogs(getActivityLogs());
    setCertificates(getCertificates());
  };

  // Case actions
  const handleCreateCase = async (data: Omit<Investigation, 'id' | 'createdAt' | 'updatedAt'>): Promise<void> => {
    const newCase = createInvestigation(data, { sync: false });
    try {
      const savedCase = isSupabaseConfigured()
        ? await syncEnsureInvestigation(newCase)
        : newCase;
      refreshState();
      setCurrentCase(savedCase);
    } catch (error) {
      removeLocalInvestigation(newCase.id);
      refreshState();
      throw error;
    }
  };

  const handleCreateEmailCase = async (
    data: Omit<Investigation, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<Investigation> => {
    await handleCreateCase(data);
    const created = getInvestigations().find((item) => item.caseNumber === data.caseNumber);
    if (!created) throw new Error('The new investigation was not available after saving.');
    return created;
  };

  const handleUpdateCaseStatus = async (id: string, status: CaseStatus): Promise<void> => {
    if (isSupabaseConfigured()) {
      const saved = await syncUpdateInvestigation(id, { status });
      if (!saved) throw new Error('The case status could not be saved to the database. No changes were committed locally.');
    }
    updateInvestigation(id, { status }, { sync: false });
    refreshState();
  };

  const handleDeleteCase = async (id: string, options?: { retainEvidenceFiles?: boolean }): Promise<void> => {
    if (isSupabaseConfigured()) {
      const deleted = await syncDeleteInvestigation(id);
      if (!deleted) throw new Error('The case could not be deleted from the database. It was retained to prevent accidental data loss.');
    }
    deleteInvestigation(id, { ...options, sync: false });
    refreshState();
  };

  // Evidence actions
  const handleAddEvidence = async (
    itemData: Omit<EvidenceItem, 'id' | 'createdAt'>,
    file?: File | Blob,
    hashesPromise?: Promise<{ sha256: string; md5: string }>,
    onUploadProgress?: (uploadedBytes: number, totalBytes: number) => void,
  ): Promise<EvidenceItem> => {
    if (!file) {
      throw new Error('The original evidence file is required for database upload.');
    }
    const targetInvestigation =
      investigations.find((investigation) => investigation.id === itemData.investigationId) ||
      getInvestigation(itemData.investigationId);
    if (!targetInvestigation) {
      throw new Error('The selected investigation is not available. Reload investigations and try again.');
    }
    if (targetInvestigation.status === 'closed') {
      throw new Error('This investigation is closed. Reopen it before uploading additional evidence.');
    }
    const savedInvestigation = await syncEnsureInvestigation(targetInvestigation);
    const savedItem = await syncAddEvidenceItem({
      ...itemData,
      investigationId: savedInvestigation.id,
    }, file, hashesPromise ?? calculateEvidenceHashes(file), onUploadProgress);
    const newItem = addEvidenceItem({
      ...itemData,
      investigationId: savedItem.investigationId,
      userId: savedItem.userId,
      sha256Hash: savedItem.sha256Hash,
      storageUrl: savedItem.storageUrl,
      previewUrl: savedItem.previewUrl,
    }, savedItem.id);
    refreshState();
    setSelectedEvidence(newItem);
    return newItem;
  };

  const handleUpdateEvidenceThumbnail = async (id: string, thumbnailUrl: string): Promise<EvidenceItem> => {
    await syncUpdateEvidenceThumbnail(id, thumbnailUrl);
    const updatedItem = updateEvidenceThumbnail(id, thumbnailUrl);
    if (!updatedItem) {
      throw new Error('Video preview was saved, but its evidence record is not available locally. Reload the case.');
    }
    refreshState();
    if (selectedEvidence?.id === id) setSelectedEvidence(updatedItem);
    return updatedItem;
  };

  const handleUpdateEvidenceMetadata = async (id: string, metadata: EvidenceMetadata): Promise<EvidenceItem> => {
    await syncUpdateEvidenceMetadata(id, metadata);
    const updatedItem = updateEvidenceItem(id, { metadata });
    if (!updatedItem) {
      throw new Error('Evidence metadata was saved, but its record is not available locally. Reload the case.');
    }
    refreshState();
    if (selectedEvidence?.id === id) setSelectedEvidence(updatedItem);
    return updatedItem;
  };

  // Findings actions
  const handleAddFinding = (findingData: Omit<AnalysisFinding, 'id' | 'createdAt'>) => {
    addFinding(findingData);
    refreshState();
  };

  const handleDeleteFinding = (id: string) => {
    deleteFinding(id);
    refreshState();
  };

  // Provenance actions
  const handleAddProvenance = (eventData: Omit<ProvenanceEvent, 'id' | 'timestamp'>) => {
    addProvenanceEvent(eventData);
    refreshState();
  };

  // User actions
  const handleUpdateUser = (updates: Partial<UserProfile>) => {
    const updated = updateCurrentUser(updates);
    setUser(updated);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(updated.id)) {
      void refreshAuthenticatedProfile().catch((error: unknown) => {
        console.error('[Auth] Could not verify Supabase workspace access:', error);
      });
    } else {
      setIsAdministratorVerified(false);
      setIsAuthProfileLoaded(true);
    }
  };

  const authModal = (
    <AuthModal
      isOpen={isAuthModalOpen}
      initialTab={authInitialTab}
      onClose={() => setIsAuthModalOpen(false)}
      currentUser={user}
      onSwitchUser={handleUpdateUser}
    />
  );

  const criticalFindingsCount = findings.filter(
    (f) => f.severity === 'critical' && (!currentCase || f.investigationId === currentCase.id)
  ).length;
  const labInvestigations = investigations.filter((investigation) => investigation.status !== 'closed');
  const labInvestigationIds = new Set(labInvestigations.map((investigation) => investigation.id));
  const labEvidence = evidenceList.filter((item) => labInvestigationIds.has(item.investigationId));
  const labCurrentCase = labInvestigations.find((investigation) => investigation.id === currentCase?.id)
    || labInvestigations[0];
  const labSelectedEvidence = selectedEvidence && labInvestigationIds.has(selectedEvidence.investigationId)
    ? selectedEvidence
    : undefined;
  const commandPalette = (
    <CommandPalette
      isOpen={isCommandPaletteOpen}
      onClose={() => setIsCommandPaletteOpen(false)}
      onNavigateTab={setCurrentTab}
      evidenceList={evidenceList}
      investigations={investigations}
      onSelectCase={setCurrentCase}
      onSelectEvidence={setSelectedEvidence}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );

  // Stage one is intentionally the only initial experience.
  if (currentTab === 'landing') {
    return (
      <>
        <Suspense fallback={<PageLoading />}>
          <LandingView
            onStartAnalysis={() => setCurrentTab('workspaces')}
            onOpenInformation={() => setCurrentTab('information')}
            isAdministrator={isAdministratorVerified}
            onOpenDestination={(section) => {
              const destinations: Record<PortalSection, NavTab> = {
                lab: 'upload',
                admin: 'admin',
                evidence_room: 'evidence_room',
                history_room: 'history_room',
              };
              setCurrentTab(destinations[section]);
            }}
          />
        </Suspense>
        {authModal}
        {commandPalette}
      </>
    );
  }

  if (currentTab === 'information') {
    return (
      <>
        <Suspense fallback={<PageLoading />}>
          <InformationView
            onHome={() => setCurrentTab('landing')}
            onOpenWorkspace={() => setCurrentTab('workspaces')}
            onOpenPrivacy={() => setCurrentTab('privacy')}
          />
        </Suspense>
        {commandPalette}
      </>
    );
  }

  if (currentTab === 'workspaces' || currentTab === 'dashboard') {
    return (
      <>
        <Suspense fallback={<PageLoading />}>
          <MainPortalView
            isAdministrator={isAdministratorVerified}
            onRefreshProfile={handleRefreshProfileAccess}
            onSignInToSupabase={() => {
              setAuthInitialTab('signin');
              setIsAuthModalOpen(true);
            }}
            onSelectSection={(section: PortalSection) => {
              const destinations: Record<PortalSection, NavTab> = {
                lab: 'upload',
                admin: 'admin',
                evidence_room: 'evidence_room',
                history_room: 'history_room',
              };
              setCurrentTab(destinations[section]);
            }}
          />
        </Suspense>
        {authModal}
      </>
    );
  }

  const restrictedWorkspace = currentTab === 'admin' || currentTab === 'investigations' || currentTab === 'case_relationships';
  if (restrictedWorkspace && !isAuthProfileLoaded) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100" aria-live="polite">
        <p className="text-sm text-slate-300">Checking your Supabase administrator access…</p>
      </main>
    );
  }

  if (restrictedWorkspace && !isAdministratorVerified) {
    const message = user.role === 'administrator'
      ? 'The local profile says administrator, but Supabase has not confirmed administrator access for the signed-in account.'
      : `Supabase profile role is "${user.role}". Admin access requires the signed-in profile role to be "administrator".`;
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
        <section className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-2xl">
          <p className="font-mono text-xs uppercase tracking-widest text-amber-300">Administrator access not verified</p>
          <h1 className="mt-3 text-2xl font-bold">Admin workspace is locked</h1>
          <p className="mt-3 text-sm leading-6 text-slate-300">{message}</p>
          <p className="mt-2 text-xs text-slate-400">
            Signed-in profile: {user.email || 'none'} · Current app role: {user.role}
          </p>
          {adminAccessMessage && <p role="status" className="mt-4 text-sm text-amber-200">{adminAccessMessage}</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void handleRefreshProfileAccess().then(setAdminAccessMessage)}
              className="rounded-lg border border-cyan-700/60 px-4 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-950/40"
            >
              Refresh Supabase access
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthInitialTab('signin');
                setIsAuthModalOpen(true);
              }}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800"
            >
              Sign in to Supabase
            </button>
            <button
              type="button"
              onClick={() => setCurrentTab('workspaces')}
              className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:text-slate-100"
            >
              Back to workspaces
            </button>
          </div>
          {adminAccessMessage && <p role="status" className="mt-4 text-sm text-slate-300">{adminAccessMessage}</p>}
          {authModal}
        </section>
      </main>
    );
  }

  return (
    <div className="lab-shell min-h-screen text-slate-100 flex flex-col font-sans">
      <Header
        user={user}
        onHome={() => setCurrentTab('landing')}
        onInformation={() => setCurrentTab('information')}
        onBackToWorkspaces={() => setCurrentTab('workspaces')}
        experienceMode={experienceMode}
        onExperienceModeChange={(mode) => {
          localStorage.setItem('vexalens_experience_mode', mode);
          setExperienceMode(mode);
        }}
        currentCase={currentCase}
        cases={investigations}
        onSelectCase={(c) => {
          setCurrentCase(c);
          // Set selected evidence to first item of this case if available
          const caseEv = evidenceList.find((e) => e.investigationId === c.id);
          if (caseEv) setSelectedEvidence(caseEv);
        }}
        onOpenAuth={() => setIsAuthModalOpen(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
        onToggleMobileSidebar={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
      />

      {/* Main Body with Sidebar + Viewport */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <Sidebar
          currentTab={currentTab}
          onTabChange={setCurrentTab}
          activeEvidenceCount={labEvidence.filter((e) => !labCurrentCase || e.investigationId === labCurrentCase.id).length}
          criticalFindingsCount={criticalFindingsCount}
          experienceMode={experienceMode}
          isMobileOpen={isMobileSidebarOpen}
          onCloseMobile={() => setIsMobileSidebarOpen(false)}
        />

        {/* Dynamic Viewport Container */}
        <Suspense fallback={<PageLoading />}>
          <main className="flex-1 overflow-y-auto bg-transparent">
            {hasDemoData && (
            <div role="note" className="m-4 border border-amber-700/70 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
              <strong className="font-semibold">DEMO DATA:</strong> Seeded cases, findings, hashes, and certificates are illustrative, not examination results. Remove them in Settings before adding real case data.
            </div>
          )}
          {currentTab === 'admin' && (
            <AdminView
              investigations={investigations}
              evidenceList={evidenceList}
              activityLogs={activityLogs}
              user={user}
              onUpdateStatus={handleUpdateCaseStatus}
              onDeleteCase={handleDeleteCase}
              onSelectCase={(inv) => {
                setCurrentCase(inv);
                const first = evidenceList.find((e) => e.investigationId === inv.id);
                if (first) setSelectedEvidence(first);
              }}
              onNavigateTab={(tab) => setCurrentTab(tab as any)}
            />
          )}

          {currentTab === 'evidence_room' && (
            <EvidenceRoomView
              evidenceList={evidenceList}
              investigations={investigations}
              onOpenEvidence={(item) => {
                setSelectedEvidence(item);
                if (item.mediaType === 'image') setCurrentTab('image_forensics');
                else if (item.mediaType === 'video') setCurrentTab('video_forensics');
                else if (item.mediaType === 'audio') setCurrentTab('audio_forensics');
                else if (item.mediaType === 'document') setCurrentTab('document_forensics');
                else setCurrentTab('evidence_room');
              }}
              onOpenCase={(inv) => {
                setCurrentCase(inv);
                setCurrentTab('admin');
              }}
            />
          )}

          {currentTab === 'ghost_recover' && (
            <GhostRecoverView
              investigations={investigations}
              currentCase={currentCase}
              user={user}
            />
          )}

          {currentTab === 'investigations' && (
            <InvestigationsView
              investigations={investigations}
              currentCase={currentCase}
              onSelectCase={(c) => {
                setCurrentCase(c);
                const first = evidenceList.find((e) => e.investigationId === c.id);
                if (first) setSelectedEvidence(first);
              }}
              onCreateCase={handleCreateCase}
              onDeleteCase={handleDeleteCase}
              onUpdateStatus={handleUpdateCaseStatus}
            />
          )}

          {currentTab === 'upload' && (
            <EvidenceUploadView
              investigations={labInvestigations}
              currentCase={labCurrentCase}
              onAddEvidence={handleAddEvidence}
              onUpdateEvidenceThumbnail={handleUpdateEvidenceThumbnail}
              onUpdateEvidenceMetadata={handleUpdateEvidenceMetadata}
              onGoToExamine={(item) => {
                setSelectedEvidence(item);
                if (item.mediaType === 'image') setCurrentTab('image_forensics');
                else if (item.mediaType === 'video') setCurrentTab('video_forensics');
                else if (item.mediaType === 'audio') setCurrentTab('audio_forensics');
                else if (item.mediaType === 'document') setCurrentTab('document_forensics');
                else setCurrentTab('evidence_room');
              }}
            />
          )}

          {currentTab === 'screenshot_detector' && (
            <ScreenshotDetectorView
              evidenceList={labEvidence}
              selectedItem={labSelectedEvidence}
              currentCase={labCurrentCase}
              onSelectEvidence={setSelectedEvidence}
              onAddFinding={handleAddFinding}
              onAddEvidence={handleAddEvidence}
            />
          )}

          {currentTab === 'email_verifier' && (
            <EmailVerifierView
              investigations={labInvestigations}
              currentCase={labCurrentCase}
              user={user}
              evidenceList={labEvidence}
              onCreateCase={handleCreateEmailCase}
              onRequestSignIn={() => {
                setAuthInitialTab('signin');
                setIsAuthModalOpen(true);
              }}
              onAddEvidence={handleAddEvidence}
            />
          )}

          {currentTab === 'document_forensics' && (
            <DocumentForensicsView
              investigations={labInvestigations}
              currentCase={labCurrentCase}
              selectedEvidence={selectedEvidence}
              requestedAnalysisId={requestedDocumentAnalysisId}
              isAdministrator={isAdministratorVerified}
              onRequestSignIn={() => {
                setAuthInitialTab('signin');
                setIsAuthModalOpen(true);
              }}
              onAddEvidence={handleAddEvidence}
            />
          )}

          {currentTab === 'batch' && (
            <BatchInvestigationView
              currentCase={labCurrentCase}
              user={user}
              onCommitBatchToCase={(items, batchFindings) => {
                items.forEach((it) => addEvidenceItem(it));
                batchFindings.forEach((fd) => addFinding(fd));
                refreshState();
                setCurrentTab('investigations');
              }}
            />
          )}

          {currentTab === 'case_relationships' && (
            <CaseRelationshipView
              investigations={labInvestigations}
              currentCase={labCurrentCase}
              evidenceList={labEvidence}
              findings={findings.filter((finding) => labInvestigationIds.has(finding.investigationId))}
              provenanceEvents={provenanceEvents.filter((event) => labInvestigationIds.has(event.investigationId))}
              onSelectEvidence={setSelectedEvidence}
              onOpenEvidence={(item) => {
                setSelectedEvidence(item);
                setCurrentTab(item.mediaType === 'image' ? 'image_forensics' : item.mediaType === 'video' ? 'video_forensics' : item.mediaType === 'audio' ? 'audio_forensics' : item.mediaType === 'document' ? 'document_forensics' : 'evidence_room');
              }}
            />
          )}

          {currentTab === 'image_forensics' && (
            <ImageForensicsView
              evidenceList={labEvidence}
              selectedItem={labSelectedEvidence}
              onSelectEvidence={setSelectedEvidence}
              onAddFinding={handleAddFinding}
            />
          )}

          {currentTab === 'image_trace' && (
            <iframe
              title="Image Trace"
              src="/image-trace.html"
              className="block h-[calc(100vh-4rem)] min-h-[640px] w-full border-0 bg-slate-950"
            />
          )}

          {currentTab === 'gps_image_tracker' && <GpsImageTrackerView />}

          {currentTab === 'video_forensics' && (
            <VideoForensicsView
              evidenceList={labEvidence}
              selectedItem={labSelectedEvidence}
              onSelectEvidence={setSelectedEvidence}
              onAddFinding={handleAddFinding}
              onTransferFrameToImageForensics={(frameUrl) => {
                // Allows opening extracted video frame in image forensics
                setCurrentTab('image_forensics');
              }}
            />
          )}

          {currentTab === 'lip_sync' && (
            <LipSyncInvestigatorView
              evidenceList={labEvidence}
              selectedItem={labSelectedEvidence}
              onSelectEvidence={setSelectedEvidence}
              onAddFinding={handleAddFinding}
            />
          )}

          {currentTab === 'audio_forensics' && (
            <AudioForensicsView
              evidenceList={labEvidence}
              selectedItem={labSelectedEvidence}
              onSelectEvidence={setSelectedEvidence}
              onAddFinding={handleAddFinding}
            />
          )}

          {currentTab === 'deepfake' && (
            <DeepfakeDetectorView
              evidenceList={labEvidence}
              selectedItem={labSelectedEvidence}
              investigations={labInvestigations}
              currentCase={labCurrentCase}
              onSelectEvidence={setSelectedEvidence}
              onAddEvidence={handleAddEvidence}
              onAddFinding={handleAddFinding}
              onNavigateTab={(tab) => setCurrentTab(tab as any)}
            />
          )}

          {currentTab === 'ai_origin' && (
            <AIOriginAssessmentView
              evidenceList={labEvidence}
              selectedItem={labSelectedEvidence}
              onSelectEvidence={setSelectedEvidence}
              onAddFinding={handleAddFinding}
              onNavigateTab={(tab) => setCurrentTab(tab as any)}
            />
          )}

          {currentTab === 'metadata_inspector' && (
            <ImageForensicsView
              evidenceList={labEvidence}
              selectedItem={labSelectedEvidence}
              onSelectEvidence={setSelectedEvidence}
              onAddFinding={handleAddFinding}
            />
          )}

          {currentTab === 'origin_intelligence' && (
            <MediaOriginIntelligenceView
              evidenceList={labEvidence}
              investigations={labInvestigations}
              user={user}
              onAddProvenance={handleAddProvenance}
              onAddEvidence={handleAddEvidence}
            />
          )}
          {currentTab === 'steganography_detector' && (
            <SteganographyDetectorView />
          )}

          {currentTab === 'signature_compare' && (
            <SignatureCompareView
              key={labCurrentCase?.id || 'no-case'}
              evidenceList={labEvidence.filter((item) => item.investigationId === labCurrentCase?.id)}
              currentCase={labCurrentCase}
              onAddEvidence={handleAddEvidence}
              onAddFinding={handleAddFinding}
            />
          )}

          {currentTab === 'photo_video_match' && (
            <PhotoToVideoMatchView
              evidenceList={labEvidence}
              onAddFinding={handleAddFinding}
            />
          )}

          {currentTab === 'comparison' && (
            <MediaComparisonView
              evidenceList={labEvidence}
              caseId={labCurrentCase?.caseNumber}
              investigationId={labCurrentCase?.id}
            />
          )}

          {currentTab === 'chain_of_custody' && (
            <ProvenanceTimelineView
              evidenceList={labEvidence}
              provenanceEvents={provenanceEvents.filter((event) => labInvestigationIds.has(event.investigationId))}
              onAddEvent={handleAddProvenance}
            />
          )}

          {currentTab === 'backend_processing' && <BackendProcessingView />}

          {currentTab === 'ai_model_status' && <AIModelStatusView />}

          {currentTab === 'timeline' && (
            <ProvenanceTimelineView
              evidenceList={labEvidence}
              provenanceEvents={provenanceEvents.filter((event) => labInvestigationIds.has(event.investigationId))}
              onAddEvent={handleAddProvenance}
            />
          )}

          {currentTab === 'certificates' && (
            <CertificatesView
              certificates={certificates.filter((certificate) => {
                const evidence = evidenceList.find((item) => item.id === certificate.evidenceId);
                return !evidence || labInvestigationIds.has(evidence.investigationId);
              })}
              evidenceList={labEvidence}
              currentCase={labCurrentCase}
              user={user}
              onSaveCertificate={(cert) => {
                saveCertificate(cert);
                refreshState();
              }}
              onRevokeCertificate={(id, reason) => {
                revokeCertificate(id, reason);
                refreshState();
              }}
            />
          )}

          {currentTab === 'findings' && (
            <FindingsView
              findings={findings.filter((finding) => labInvestigationIds.has(finding.investigationId))}
              evidenceList={labEvidence}
              onOpenEvidence={(item) => {
                setSelectedEvidence(item);
                setCurrentTab(item.mediaType === 'image' ? 'image_forensics' : item.mediaType === 'video' ? 'video_forensics' : item.mediaType === 'audio' ? 'audio_forensics' : item.mediaType === 'document' ? 'document_forensics' : 'evidence_room');
              }}
              onAddFinding={handleAddFinding}
              onDeleteFinding={handleDeleteFinding}
            />
          )}

          {currentTab === 'reports' && (
            <ReportsView
              currentCase={currentCase}
              investigations={investigations}
              evidenceList={evidenceList}
              findings={findings}
              provenanceEvents={provenanceEvents}
              certificates={certificates}
              user={user}
              onSelectCase={setCurrentCase}
              onOpenEvidence={(item) => {
                setSelectedEvidence(item);
                setCurrentTab(item.mediaType === 'image' ? 'image_forensics' : item.mediaType === 'video' ? 'video_forensics' : item.mediaType === 'audio' ? 'audio_forensics' : item.mediaType === 'document' ? 'document_forensics' : 'evidence_room');
              }}
              onNavigateTab={(tab) => setCurrentTab(tab as any)}
            />
          )}

          {currentTab === 'history_room' && (
            <HistoryRoomView
              investigations={investigations}
              evidenceList={evidenceList}
              findings={findings}
              provenanceEvents={provenanceEvents}
              user={user}
              onSelectCase={(inv) => {
                setCurrentCase(inv);
                const first = evidenceList.find((e) => e.investigationId === inv.id);
                if (first) setSelectedEvidence(first);
              }}
              onNavigateTab={(tab) => setCurrentTab(tab as any)}
              onViewDocumentAnalysis={(analysis) => {
                setRequestedDocumentAnalysisId(analysis.id);
                const evidence = evidenceList.find((item) => item.id === analysis.evidenceId);
                if (evidence) setSelectedEvidence(evidence);
                setCurrentTab('document_forensics');
              }}
            />
          )}

          {currentTab === 'privacy' && (
            <PrivacySharingView
              user={user}
              currentCase={currentCase}
              investigations={investigations}
            />
          )}

          {currentTab === 'settings' && (
            <SettingsView
              user={user}
              onUpdateUser={handleUpdateUser}
              onDataReset={refreshState}
              onOpenServices={() => setCurrentTab('services')}
            />
          )}

            {currentTab === 'services' && <ForensicServicesView />}
          </main>
        </Suspense>
      </div>

      {authModal}

      {commandPalette}
    </div>
  );
}
