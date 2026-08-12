import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bufferIterable, contentAddressedBlobKey, HmacSignedBlobUrlProvider,
  LocalFileBlobStore, MemoryBlobStore
} from './blobStore';

describe('BlobStore', () => {
  it('streams, verifies and promotes content to a content-addressed key', async () => {
    const store = new MemoryBlobStore();
    const digest = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    await store.put('staging/upload-a', bufferIterable('hello'), {
      maxBytes: 5, expectedSizeBytes: 5, expectedSha256: digest
    });
    const promoted = await store.promote('staging/upload-a', digest);
    expect(promoted.key).toBe(contentAddressedBlobKey(digest));
    expect(await store.stat('staging/upload-a')).toBeUndefined();
    expect(Buffer.concat(await collect(store.read(promoted.key))).toString()).toBe('hello');
  });

  it('rejects oversize, bad hashes and traversal keys', async () => {
    const store = new MemoryBlobStore();
    await expect(store.put('staging/large', bufferIterable('hello'), { maxBytes: 4 })).rejects.toMatchObject({ code: 'blob_too_large' });
    await expect(store.put('../escape', bufferIterable('x'), { maxBytes: 1 })).rejects.toMatchObject({ code: 'invalid_blob_key' });
    await expect(store.put('staging/hash', bufferIterable('x'), { maxBytes: 1, expectedSha256: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'blob_hash_mismatch' });
  });

  it('keeps local file writes under their configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kross-blobs-'));
    const store = new LocalFileBlobStore(root);
    await store.put('safe/file.txt', bufferIterable('value'), { maxBytes: 10 });
    expect(await readFile(join(root, 'safe/file.txt'), 'utf8')).toBe('value');
    await expect(store.stat('safe/../../escape')).rejects.toMatchObject({ code: 'invalid_blob_key' });
  });

  it('signs action-scoped short-lived URLs and rejects tampering', () => {
    const signer = new HmacSignedBlobUrlProvider('a-secure-secret-that-is-at-least-32-bytes', 'https://control.example');
    const url = new URL(signer.createUploadUrl({ blobKey: 'staging/a', expiresAt: new Date(Date.now() + 60_000).toISOString(), maxBytes: 8 }));
    const token = url.pathname.split('/').at(-1)!;
    expect(signer.verify(token, 'upload')).toMatchObject({ blobKey: 'staging/a', maxBytes: 8 });
    expect(() => signer.verify(`${token}x`, 'upload')).toThrow(/Invalid or expired/);
    expect(() => signer.verify(token, 'download')).toThrow(/Invalid or expired/);
  });
});

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of iterable) chunks.push(Buffer.from(chunk));
  return chunks;
}
