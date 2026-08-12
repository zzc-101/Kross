import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { ServerError } from './errors';

export interface BlobMetadata {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface BlobWriteOptions {
  readonly maxBytes: number;
  readonly expectedSizeBytes?: number;
  readonly expectedSha256?: string;
}

export interface BlobStore {
  put(key: string, content: AsyncIterable<Uint8Array>, options: BlobWriteOptions): Promise<BlobMetadata>;
  stat(key: string): Promise<BlobMetadata | undefined>;
  read(key: string): AsyncIterable<Uint8Array>;
  promote(stagingKey: string, sha256: string): Promise<BlobMetadata>;
  delete(key: string): Promise<void>;
}

export function contentAddressedBlobKey(sha256: string): string {
  assertSha256(sha256);
  return `sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  public async put(key: string, content: AsyncIterable<Uint8Array>, options: BlobWriteOptions): Promise<BlobMetadata> {
    assertBlobKey(key);
    if (this.blobs.has(key)) throw new ServerError('blob_already_exists', 'Blob already exists', 409);
    const chunks: Uint8Array[] = [];
    let sizeBytes = 0;
    const hash = createHash('sha256');
    for await (const chunk of content) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > options.maxBytes) throw new ServerError('blob_too_large', 'Blob exceeds its size limit', 413);
      hash.update(chunk);
      chunks.push(Uint8Array.from(chunk));
    }
    const sha256 = hash.digest('hex');
    assertExpectedBlob(sizeBytes, sha256, options);
    this.blobs.set(key, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
    return { key, sizeBytes, sha256 };
  }

  public async stat(key: string): Promise<BlobMetadata | undefined> {
    assertBlobKey(key);
    const value = this.blobs.get(key);
    if (!value) return undefined;
    return { key, sizeBytes: value.byteLength, sha256: createHash('sha256').update(value).digest('hex') };
  }

  public async *read(key: string): AsyncIterable<Uint8Array> {
    assertBlobKey(key);
    const value = this.blobs.get(key);
    if (!value) throw new ServerError('blob_not_found', 'Blob not found', 404);
    yield Uint8Array.from(value);
  }

  public async promote(stagingKey: string, sha256: string): Promise<BlobMetadata> {
    assertSha256(sha256);
    const source = this.blobs.get(stagingKey);
    if (!source) throw new ServerError('blob_not_found', 'Uploaded blob not found', 404);
    const actual = createHash('sha256').update(source).digest('hex');
    if (actual !== sha256) throw new ServerError('blob_hash_mismatch', 'Blob hash does not match', 422);
    const key = contentAddressedBlobKey(sha256);
    if (!this.blobs.has(key)) this.blobs.set(key, Uint8Array.from(source));
    this.blobs.delete(stagingKey);
    return { key, sizeBytes: source.byteLength, sha256 };
  }

  public async delete(key: string): Promise<void> {
    assertBlobKey(key);
    this.blobs.delete(key);
  }
}

export class LocalFileBlobStore implements BlobStore {
  private readonly root: string;
  public constructor(root: string) { this.root = resolve(root); }

  public async put(key: string, content: AsyncIterable<Uint8Array>, options: BlobWriteOptions): Promise<BlobMetadata> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, 'wx');
    const stream = createWriteStream(path, { fd: handle.fd, autoClose: false });
    let sizeBytes = 0;
    const hash = createHash('sha256');
    try {
      for await (const chunk of content) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > options.maxBytes) throw new ServerError('blob_too_large', 'Blob exceeds its size limit', 413);
        hash.update(chunk);
        if (!stream.write(chunk)) await new Promise<void>((resolveDrain) => stream.once('drain', resolveDrain));
      }
      await new Promise<void>((resolveEnd, reject) => stream.end((error?: Error | null) => error ? reject(error) : resolveEnd()));
      const sha256 = hash.digest('hex');
      assertExpectedBlob(sizeBytes, sha256, options);
      return { key, sizeBytes, sha256 };
    } catch (error) {
      stream.destroy();
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      if (!stream.closed) await handle.close().catch(() => undefined);
    }
  }

  public async stat(key: string): Promise<BlobMetadata | undefined> {
    const path = this.path(key);
    try {
      const info = await stat(path);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return { key, sizeBytes: info.size, sha256: hash.digest('hex') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  public read(key: string): AsyncIterable<Uint8Array> { return createReadStream(this.path(key)); }

  public async promote(stagingKey: string, sha256: string): Promise<BlobMetadata> {
    const metadata = await this.stat(stagingKey);
    if (!metadata) throw new ServerError('blob_not_found', 'Uploaded blob not found', 404);
    if (metadata.sha256 !== sha256) throw new ServerError('blob_hash_mismatch', 'Blob hash does not match', 422);
    const key = contentAddressedBlobKey(sha256);
    const destination = this.path(key);
    await mkdir(dirname(destination), { recursive: true });
    if (await this.stat(key)) await unlink(this.path(stagingKey)).catch(() => undefined);
    else await rename(this.path(stagingKey), destination);
    return { key, sizeBytes: metadata.sizeBytes, sha256 };
  }

  public async delete(key: string): Promise<void> { await unlink(this.path(key)).catch(() => undefined); }

  private path(key: string): string {
    assertBlobKey(key);
    const path = resolve(join(this.root, key));
    if (!path.startsWith(`${this.root}/`)) throw new ServerError('invalid_blob_key', 'Invalid blob key', 400);
    return path;
  }
}

export type SignedBlobAction = 'upload' | 'download';
export interface SignedBlobClaim {
  readonly action: SignedBlobAction;
  readonly blobKey: string;
  readonly expiresAt: string;
  readonly maxBytes?: number;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly mimeType?: string;
}

export interface SignedBlobUrlProvider {
  createUploadUrl(claim: Omit<SignedBlobClaim, 'action'>): string;
  createDownloadUrl(claim: Omit<SignedBlobClaim, 'action'>): string;
  verify(token: string, action: SignedBlobAction): SignedBlobClaim;
}

export class HmacSignedBlobUrlProvider implements SignedBlobUrlProvider {
  public constructor(private readonly secret: string, private readonly baseUrl: string) {
    if (Buffer.byteLength(secret) < 32) throw new Error('Blob signing secret must contain at least 32 bytes');
  }
  public createUploadUrl(claim: Omit<SignedBlobClaim, 'action'>): string { return this.sign({ ...claim, action: 'upload' }); }
  public createDownloadUrl(claim: Omit<SignedBlobClaim, 'action'>): string { return this.sign({ ...claim, action: 'download' }); }
  public verify(token: string, action: SignedBlobAction): SignedBlobClaim {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) throw invalidSignature();
    const expected = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    const left = Buffer.from(signature); const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw invalidSignature();
    let claim: SignedBlobClaim;
    try { claim = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedBlobClaim; }
    catch { throw invalidSignature(); }
    if (claim.action !== action || Date.parse(claim.expiresAt) <= Date.now()) throw invalidSignature();
    assertBlobKey(claim.blobKey);
    return claim;
  }
  private sign(claim: SignedBlobClaim): string {
    assertBlobKey(claim.blobKey);
    const encoded = Buffer.from(JSON.stringify(claim)).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${this.baseUrl.replace(/\/$/, '')}/api/v2/blobs/${claim.action}/${encoded}.${signature}`;
  }
}

export function bufferIterable(value: Uint8Array | string): AsyncIterable<Uint8Array> {
  return Readable.from([typeof value === 'string' ? Buffer.from(value) : value]);
}

function assertExpectedBlob(sizeBytes: number, sha256: string, options: BlobWriteOptions): void {
  if (options.expectedSizeBytes !== undefined && sizeBytes !== options.expectedSizeBytes) {
    throw new ServerError('blob_size_mismatch', 'Blob size does not match', 422);
  }
  if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
    throw new ServerError('blob_hash_mismatch', 'Blob hash does not match', 422);
  }
}
function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new ServerError('invalid_sha256', 'Invalid SHA-256 digest', 400);
}
function assertBlobKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,1023}$/.test(key) || key.includes('..')) {
    throw new ServerError('invalid_blob_key', 'Invalid blob key', 400);
  }
}
function invalidSignature(): ServerError { return new ServerError('invalid_blob_signature', 'Invalid or expired blob URL', 403); }
