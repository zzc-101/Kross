export function sessionPresentationState(state: {
  activeSessionId?: string;
  snapshot?: unknown;
}): 'empty' | 'loading' | 'ready' {
  if (state.snapshot) return 'ready';
  if (state.activeSessionId) return 'loading';
  return 'empty';
}
