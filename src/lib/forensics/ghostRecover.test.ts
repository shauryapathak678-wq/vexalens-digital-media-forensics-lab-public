import { describe, expect, it } from 'vitest';
import {
  createGhostRecoverCustodyEntry,
  verifyGhostRecoverCustodyChain,
} from './ghostRecover';

describe('GhostRecover custody chain', () => {
  it('verifies a linked sequence and detects modified entries', async () => {
    const first = await createGhostRecoverCustodyEntry({
      id: 'custody-1',
      caseId: 'case-1',
      action: 'artifact_hashed',
      actor: 'Investigator',
      recordedAt: '2026-11-17T10:00:00.000Z',
      subjectId: 'artifact-1',
      subjectSha256: 'a'.repeat(64),
    }, null);
    const second = await createGhostRecoverCustodyEntry({
      id: 'custody-2',
      caseId: 'case-1',
      action: 'timeline_event_recorded',
      actor: 'Investigator',
      recordedAt: '2026-11-17T10:01:00.000Z',
      subjectId: 'event-1',
      subjectSha256: 'b'.repeat(64),
    }, first.entrySha256);

    expect(await verifyGhostRecoverCustodyChain([first, second])).toEqual({
      valid: true,
      checkedCount: 2,
      invalidIndex: null,
    });
    expect(await verifyGhostRecoverCustodyChain([first, { ...second, actor: 'Changed' }])).toEqual({
      valid: false,
      checkedCount: 1,
      invalidIndex: 1,
    });
  });
});
