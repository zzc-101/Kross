const INHERITED_ENV_NAMES = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'PATH',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE'
] as const;

/** Keep control-plane and model credentials out of Agent-started processes. */
export function buildSubprocessEnv(
  inherited: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_ENV_NAMES) {
    const value = inherited[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!name || name.includes('=') || name.includes('\0') || value.includes('\0')) {
      throw new Error(`Invalid environment override key: ${name}`);
    }
    env[name] = value;
  }
  return env;
}
