import { describe, expect, it } from 'vitest';
import {
  buildShareLinkRecord,
  describeShareStatus,
  generateShareToken,
  hoursUntilExpiry,
  isShareLinkActive,
  shareScopeLabel,
} from './sharing';

const NOW = new Date('2026-01-01T12:00:00.000Z');

function makeLink(overrides: Partial<ReturnType<typeof buildShareLinkRecord>> = {}) {
  return { ...buildShareLinkRecord({ reportId: 'rep_1', scope: 'report_summary', createdBy: 'Analyst', now: NOW }), ...overrides };
}

describe('share token generation', () => {
  it('produces a 32-character hex token', () => {
    const token = generateShareToken();
    expect(token).toMatch(/^[a-f0-9]{32}$/);
  });

  it('produces distinct tokens', () => {
    expect(generateShareToken()).not.toBe(generateShareToken());
  });
});

describe('share link expiry and access control', () => {
  it('is active immediately and expires after the configured TTL', () => {
    const link = buildShareLinkRecord({ reportId: 'rep_1', scope: 'full_report', createdBy: 'Analyst', ttlHours: 24, now: NOW });
    expect(link.expiresAt).toBe('2026-01-02T12:00:00.000Z');
    expect(isShareLinkActive(link, NOW)).toBe(true);
    const afterExpiry = new Date('2026-01-03T12:00:00.000Z');
    expect(isShareLinkActive(link, afterExpiry)).toBe(false);
    expect(describeShareStatus(link, afterExpiry)).toBe('expired');
  });

  it('treats a revoked link as inactive even before expiry', () => {
    const link = makeLink({ revoked: true, revokedReason: 'Recipient changed' });
    expect(isShareLinkActive(link, NOW)).toBe(false);
    expect(describeShareStatus(link, NOW)).toBe('revoked');
  });

  it('defaults to 72 hours when the TTL is invalid', () => {
    const link = buildShareLinkRecord({ reportId: 'rep_1', scope: 'report_summary', createdBy: 'Analyst', ttlHours: 0, now: NOW });
    expect(hoursUntilExpiry(link, NOW)).toBeCloseTo(72, 5);
  });

  it('labels scopes for display', () => {
    expect(shareScopeLabel('report_summary')).toBe('Simple report summary');
    expect(shareScopeLabel('full_report')).toBe('Full forensic report');
  });
});
