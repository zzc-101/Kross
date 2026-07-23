import { useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  installable: boolean;
  installed: boolean;
  updateAvailable: boolean;
  offline: boolean;
}

let installPrompt: InstallPromptEvent | undefined;
let registration: ServiceWorkerRegistration | undefined;
let reloadOnControllerChange = false;
let initialized = false;
let state: PwaState = {
  installable: false,
  installed: isStandalone(),
  updateAvailable: false,
  offline: typeof navigator !== 'undefined' ? !navigator.onLine : false
};
const listeners = new Set<() => void>();

export function initializePwa(): void {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    updateState({ installable: true });
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = undefined;
    updateState({ installable: false, installed: true });
  });
  window.addEventListener('online', () => updateState({ offline: false }));
  window.addEventListener('offline', () => updateState({ offline: true }));

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => void registerServiceWorker());
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!reloadOnControllerChange) return;
      reloadOnControllerChange = false;
      window.location.reload();
    });
  }
}

export function usePwa(): PwaState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export async function installPwa(): Promise<boolean> {
  if (!installPrompt) return false;
  const prompt = installPrompt;
  await prompt.prompt();
  const choice = await prompt.userChoice;
  if (choice.outcome === 'accepted') {
    installPrompt = undefined;
    updateState({ installable: false, installed: true });
    return true;
  }
  return false;
}

export function applyPwaUpdate(): void {
  const worker = registration?.waiting;
  if (!worker) return;
  reloadOnControllerChange = true;
  worker.postMessage({ type: 'SKIP_WAITING' });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): PwaState {
  return state;
}

function updateState(patch: Partial<PwaState>): void {
  const next = { ...state, ...patch };
  if (
    next.installable === state.installable &&
    next.installed === state.installed &&
    next.updateAvailable === state.updateAvailable &&
    next.offline === state.offline
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

async function registerServiceWorker(): Promise<void> {
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    if (registration.waiting) updateState({ updateAvailable: true });
    registration.addEventListener('updatefound', () => {
      const installing = registration?.installing;
      installing?.addEventListener('statechange', () => {
        if (
          installing.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          updateState({ updateAvailable: true });
        }
      });
    });
  } catch {
    // PWA 注册失败不影响 Web 主流程。
  }
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
