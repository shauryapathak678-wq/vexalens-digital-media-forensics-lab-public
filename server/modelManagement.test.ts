import { describe, expect, it } from 'vitest';
import { getInstallationStatus, type ModelDefinition, type VerifiedModelFile } from './modelManagement';

const blockedModel: Pick<ModelDefinition, 'licenseGate'> = { licenseGate: 'blocked_until_separately_cleared' };
const approvedModel: Pick<ModelDefinition, 'licenseGate'> = { licenseGate: 'clear' };

function file(present: boolean, integrityStatus: VerifiedModelFile['integrityStatus']) {
  return { present, integrityStatus };
}

describe('getInstallationStatus', () => {
  it('keeps absent restricted models blocked instead of reporting them as installed', () => {
    expect(getInstallationStatus(blockedModel, [file(false, 'missing')])).toBe('blocked_by_license');
  });

  it('reports an absent approved model as not installed', () => {
    expect(getInstallationStatus(approvedModel, [file(false, 'missing')])).toBe('not_installed');
  });

  it('reports a partial multi-checkpoint installation', () => {
    expect(getInstallationStatus(approvedModel, [
      file(true, 'verified'),
      file(false, 'missing'),
    ])).toBe('partial_install');
  });

  it('distinguishes verified publisher references from local-only hashes', () => {
    expect(getInstallationStatus(approvedModel, [file(true, 'verified')])).toBe('installed_verified');
    expect(getInstallationStatus(approvedModel, [file(true, 'local_hash_only')])).toBe('installed_unverified');
  });

  it('flags any detected integrity mismatch', () => {
    expect(getInstallationStatus(approvedModel, [
      file(true, 'verified'),
      file(true, 'mismatch'),
    ])).toBe('integrity_error');
  });
});
