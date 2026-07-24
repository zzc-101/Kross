import { describe, expect, it } from 'vitest';

import { sessionPresentationState } from './sessionPresentation';

describe('sessionPresentationState', () => {
  it('shows a loading state while the selected session snapshot is pending', () => {
    expect(
      sessionPresentationState({
        activeSessionId: 'session-b',
        snapshot: undefined
      })
    ).toBe('loading');
  });

  it('shows the welcome state only when no session is selected', () => {
    expect(sessionPresentationState({})).toBe('empty');
  });

  it('shows chat content once the selected snapshot arrives', () => {
    expect(
      sessionPresentationState({
        activeSessionId: 'session-b',
        snapshot: { summary: { id: 'session-b' } }
      })
    ).toBe('ready');
  });
});
