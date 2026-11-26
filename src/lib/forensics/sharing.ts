/**
 * Report sharing and consent management.
 *
 * Honest scope note: VexaLens does not host evidence or reports on a public
 * server in this build. A "share link" is an expiring, access-controlled local
 * reference (an opaque token plus metadata) that an authorised operator must
 * transfer through a secure channel. It never becomes a public URL by itself.
 */
import { ShareLink, ShareScope, ExternalProcessingConsent } from '@/types/forensics';
import { logActivity } from '../storage';

export const DEFAULT_SHARE_TTL_HOURS = 72;
export const SHARE_TOKEN_BYTES = 16;

const SHARE_LINKS_KEY = 'vexalens_share_links';
const EXTERNAL_CONSENT_KEY = 'vexalens_external_processing_consent';

export type ShareLinkStatus = 'active' | 'expired' | 'revoked';

/** Cryptographically random opaque token (32 hex chars). */
export function generateShareToken(): string {
  const bytes = new Uint8Array(SHARE_TOKEN_BYTES);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function describeShareStatus(link: ShareLink, now: Date = new Date()): ShareLinkStatus {
  if (link.revoked) return 'revoked';
  return new Date(link.expiresAt).getTime() > now.getTime() ? 'active' : 'expired';
}

/** A share link is usable only while it is neither revoked nor expired. */
export function isShareLinkActive(link: ShareLink, now: Date = new Date()): boolean {
  return describeShareStatus(link, now) === 'active';
}

export function shareScopeLabel(scope: ShareScope): string {
  return scope === 'full_report' ? 'Full forensic report' : 'Simple report summary';
}

export function hoursUntilExpiry(link: ShareLink, now: Date = new Date()): number {
  return (new Date(link.expiresAt).getTime() - now.getTime()) / (1000 * 60 * 60);
}

export function buildShareLinkRecord(input: {
  reportId: string;
  caseId?: string;
  scope: ShareScope;
  createdBy: string;
  ttlHours?: number;
  now?: Date;
}): ShareLink {
  const now = input.now ?? new Date();
  const ttlHours = input.ttlHours && input.ttlHours > 0 ? input.ttlHours : DEFAULT_SHARE_TTL_HOURS;
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);
  return {
    id: `shr_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
    token: generateShareToken(),
    reportId: input.reportId,
    caseId: input.caseId,
    scope: input.scope,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revoked: false,
    createdBy: input.createdBy,
    consentAcknowledgedAt: now.toISOString(),
    accessCount: 0,
  };
}

// ---- Persistence (local only, never public) ----

export function getShareLinks(): ShareLink[] {
  try {
    const raw = localStorage.getItem(SHARE_LINKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ShareLink[]) : [];
  } catch {
    return [];
  }
}

export function saveShareLink(link: ShareLink): ShareLink {
  const all = getShareLinks();
  localStorage.setItem(SHARE_LINKS_KEY, JSON.stringify([link, ...all]));
  logActivity(
    'REPORT_SHARED',
    `Expiring share link created for report ${link.reportId} (${shareScopeLabel(link.scope)}); expires ${new Date(link.expiresAt).toLocaleString()}.`
  );
  return link;
}

export function revokeShareLink(id: string, reason: string): boolean {
  const all = getShareLinks();
  const link = all.find((item) => item.id === id);
  if (!link) return false;
  link.revoked = true;
  link.revokedReason = reason;
  localStorage.setItem(SHARE_LINKS_KEY, JSON.stringify(all));
  logActivity('SHARE_REVOKED', `Share link for report ${link.reportId} revoked: ${reason}`);
  return true;
}

export function deleteAllShareLinks(): void {
  localStorage.removeItem(SHARE_LINKS_KEY);
  logActivity('SHARE_CLEARED', 'All share links deleted by the operator.');
}

export function getExternalProcessingConsent(): ExternalProcessingConsent {
  try {
    const raw = localStorage.getItem(EXTERNAL_CONSENT_KEY);
    if (!raw) return { acknowledged: false };
    return JSON.parse(raw) as ExternalProcessingConsent;
  } catch {
    return { acknowledged: false };
  }
}

export function setExternalProcessingConsent(acknowledged: boolean, by: string): ExternalProcessingConsent {
  const record: ExternalProcessingConsent = acknowledged
    ? { acknowledged: true, acknowledgedAt: new Date().toISOString(), acknowledgedBy: by }
    : { acknowledged: false };
  localStorage.setItem(EXTERNAL_CONSENT_KEY, JSON.stringify(record));
  if (acknowledged) {
    logActivity('CONSENT_RECORDED', 'Operator acknowledged the external-processing privacy notice.');
  }
  return record;
}
