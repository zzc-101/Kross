import { describe, expect, it } from 'vitest';

import { latestToolActivities } from './toolActivity';

describe('latestToolActivities', () => {
  it('keeps only the latest lifecycle event for each tool call', () => {
    expect(
      latestToolActivities(
        [
          {
            id: 'started',
            type: 'tool_call.started',
            payload: { callId: 'call-1', toolName: 'Read' }
          },
          {
            id: 'completed',
            type: 'tool_call.completed',
            payload: { callId: 'call-1', toolName: 'Read' }
          }
        ],
        new Set()
      )
    ).toEqual([
      {
        id: 'completed',
        type: 'tool_call.completed',
        payload: { callId: 'call-1', toolName: 'Read' }
      }
    ]);
  });

  it('hides calls already represented by persisted tool messages', () => {
    expect(
      latestToolActivities(
        [
          {
            id: 'completed',
            type: 'tool_call.completed',
            payload: { callId: 'call-1', toolName: 'Read' }
          }
        ],
        new Set(['call-1'])
      )
    ).toEqual([]);
  });
});
