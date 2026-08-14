import { describe, expect, it } from 'vitest';

import {
  fingerprintCommand,
  identifyRequestedVerificationCommand,
  identifyVerificationCommand
} from './verificationCommand';

describe('verificationCommand', () => {
  it.each([
    ['npm test -- --run src/a.test.ts', 'npm test', 'test'],
    ['npm run typecheck', 'npm run typecheck', 'typecheck'],
    ['pnpm run build', 'pnpm run build', 'build'],
    ['yarn lint --fix', 'yarn lint', 'lint'],
    ['npx tsc --noEmit -p tsconfig.json', 'tsc --noEmit', 'typecheck'],
    ['cargo test --workspace', 'cargo test', 'test']
  ])('recognizes %s without retaining arguments', (command, label, kind) => {
    const identified = identifyVerificationCommand(command);
    expect(identified?.label).toContain(label);
    expect(identified?.kinds).toContain(kind);
    expect(identified?.label).not.toContain('src/a.test.ts');
    expect(identified?.label).not.toContain('tsconfig.json');
  });

  it('returns undefined for ordinary shell commands', () => {
    expect(identifyVerificationCommand('ls -la')).toBeUndefined();
    expect(identifyVerificationCommand('node server.js')).toBeUndefined();
    expect(
      identifyVerificationCommand('echo "npm test uses vitest.config.ts"')
    ).toBeUndefined();
  });

  it('recognizes checks after environment prefixes and shell sequencing', () => {
    const identified = identifyVerificationCommand(
      'cd app && HOME=/tmp/test npm run typecheck && npm test'
    );
    expect(identified?.label).toBe('npm run typecheck && npm test');
  });

  it.each([
    'npm test || true',
    'npm test; echo done',
    'npm test | tee test.log',
    'npm test &',
    'npm test\necho done'
  ])('rejects checks whose exit status can be masked: %s', (command) => {
    expect(identifyVerificationCommand(command)).toBeUndefined();
  });

  it('allows shell-like characters inside quoted arguments', () => {
    expect(identifyVerificationCommand('npm test -- --name "a|b;c"')?.label).toBe(
      'npm test'
    );
    expect(identifyVerificationCommand('npm test > test.log 2>&1')?.label).toBe(
      'npm test'
    );
  });

  it('normalizes whitespace before fingerprinting', () => {
    expect(fingerprintCommand(' npm   test ')).toBe(
      fingerprintCommand('npm test')
    );
  });

  it('detects explicit requested checks without treating discussion as a request', () => {
    expect(
      identifyRequestedVerificationCommand('请运行 `npm test -- --run src/a.test.ts`')
        ?.label
    ).toBe('npm test');
    expect(
      identifyRequestedVerificationCommand('Why can npm test be flaky?')
    ).toBeUndefined();
    expect(
      identifyRequestedVerificationCommand('告诉我如何运行 npm test')
    ).toBeUndefined();
  });
});
