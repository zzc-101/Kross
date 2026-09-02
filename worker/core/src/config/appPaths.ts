import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppHomeOptions {
  homeDir?: string;
  appHome?: string;
}

export function resolveAppHome(options: AppHomeOptions = {}): string {
  return options.appHome ?? join(options.homeDir ?? homedir(), '.kross');
}
