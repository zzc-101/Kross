export type WorkbenchRoute =
  | { view: 'home' }
  | { view: 'task'; projectId: string; taskId?: string };

export function readRoute(location: Pick<Location, 'pathname' | 'search'>): WorkbenchRoute {
  const match = location.pathname.match(/^\/projects\/([^/]+)(?:\/tasks\/([^/]+))?\/?$/);
  if (!match) return { view: 'home' };
  return {
    view: 'task',
    projectId: decodeURIComponent(match[1]!),
    ...(match[2] ? { taskId: decodeURIComponent(match[2]) } : {})
  };
}

export function routePath(route: WorkbenchRoute): string {
  if (route.view === 'home') return '/';
  const project = `/projects/${encodeURIComponent(route.projectId)}`;
  return route.taskId ? `${project}/tasks/${encodeURIComponent(route.taskId)}` : project;
}

export function navigate(route: WorkbenchRoute, replace = false): void {
  const path = routePath(route);
  if (`${location.pathname}${location.search}` === path) return;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
