import { describe, expect, it } from 'vitest';

import { formatProcessCommandPreview } from './processCommandPreview';

describe('formatProcessCommandPreview', () => {
  it('keeps command shape while dropping argument, option and env values', () => {
    const preview = formatProcessCommandPreview(
      'API_TOKEN=inline-secret /usr/bin/curl --header="Bearer hidden" https://user:pass@example.test | tee private.txt'
    );

    expect(preview).toContain('API_TOKEN=…');
    expect(preview).toContain('curl → tee');
    expect(preview).toContain('--header');
    expect(preview).toContain('2 args');
    expect(preview).not.toContain('inline-secret');
    expect(preview).not.toContain('Bearer hidden');
    expect(preview).not.toContain('user:pass');
    expect(preview).not.toContain('private.txt');
  });

  it('is bounded even for very long shell payloads', () => {
    const preview = formatProcessCommandPreview(`node -e "${'secret'.repeat(200)}"`, 80);
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview).not.toContain('secret');
  });

  it('never retains values attached to short or long options', () => {
    const preview = formatProcessCommandPreview(
      'mysql -pmysecret --password=another-secret && curl -uuser:pass --header="Authorization: hidden"'
    );
    expect(preview).toContain('-p…');
    expect(preview).toContain('-u…');
    expect(preview).toContain('--password');
    expect(preview).toContain('--header');
    expect(preview).not.toContain('mysecret');
    expect(preview).not.toContain('another-secret');
    expect(preview).not.toContain('user:pass');
    expect(preview).not.toContain('Authorization');
  });
});
