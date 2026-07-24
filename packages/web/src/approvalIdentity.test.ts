import { describe, expect, it } from 'vitest';

import { approvalIdentity } from './approvalIdentity';

describe('approvalIdentity', () => {
  it('changes for consecutive tool approvals in the same run', () => {
    expect(
      approvalIdentity({ runId: 'run-1', toolCallId: 'tool-2' })
    ).not.toBe(
      approvalIdentity({ runId: 'run-1', toolCallId: 'tool-1' })
    );
  });

  it('is stable for repeated events of the same approval', () => {
    expect(
      approvalIdentity({ runId: 'run-1', toolCallId: 'tool-1' })
    ).toBe(
      approvalIdentity({ runId: 'run-1', toolCallId: 'tool-1' })
    );
  });
});
