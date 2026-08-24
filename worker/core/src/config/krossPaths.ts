import { homedir } from 'node:os';
import { join } from 'node:path';

export interface KrossHomeOptions {
  homeDir?: string;
  krossHome?: string;
}

export function resolveKrossHome(options: KrossHomeOptions = {}): string {
  return options.krossHome ?? join(options.homeDir ?? homedir(), '.kross');
}
