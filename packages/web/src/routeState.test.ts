import { describe, expect, it } from 'vitest';
import { readRoute, routePath } from './routeState';

describe('routeState', () => {
  it('round trips a task route with encoded identifiers', () => {
    const path = routePath({ view: 'task', projectId: 'project one', taskId: 'task/二' });
    expect(path).toBe('/projects/project%20one/tasks/task%2F%E4%BA%8C');
    expect(readRoute({ pathname: path, search: '' } as Location)).toEqual({
      view: 'task', projectId: 'project one', taskId: 'task/二'
    });
  });

  it('treats unknown paths as home', () => {
    expect(readRoute({ pathname: '/unknown', search: '' } as Location)).toEqual({ view: 'home' });
  });
});
