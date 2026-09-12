import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkspaceCommand } from './workspaceCommands';

let root: string;
let outside: string;
let previousS3Endpoint: string | undefined;

beforeEach(async () => {
  previousS3Endpoint = process.env.APP_S3_ENDPOINT;
  delete process.env.APP_S3_ENDPOINT;
  root = await mkdtemp(join(tmpdir(), 'app-workspace-command-'));
  outside = await mkdtemp(join(tmpdir(), 'app-workspace-outside-'));
});

afterEach(async () => {
  if (previousS3Endpoint === undefined) {
    delete process.env.APP_S3_ENDPOINT;
  } else {
    process.env.APP_S3_ENDPOINT = previousS3Endpoint;
  }
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]);
});

function command(name: string, payload: Record<string, unknown>) {
  return handleWorkspaceCommand(root, { commandId: 'command-1', name, payload });
}

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  return new Promise<{ server: Server; url: string }>((resolve, reject) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to bind test server'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}/object.bin` });
    });
    server.on('error', reject);
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('workspace commands', () => {
  it('reads and writes regular workspace files', async () => {
    await command('workspace.write', { path: 'notes/item.txt', content: 'safe' });

    expect(await readFile(join(root, 'notes', 'item.txt'), 'utf8')).toBe('safe');
    await expect(command('workspace.read', { path: 'notes/item.txt' })).resolves.toMatchObject({
      content: 'safe'
    });
  });

  it('rejects reads and writes through symlinks escaping the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await mkdir(join(root, 'links'));
    await symlink(outside, join(root, 'links', 'escape'));

    await expect(command('workspace.read', {
      path: 'links/escape/secret.txt'
    })).rejects.toThrow('workspace');
    await expect(command('workspace.write', {
      path: 'links/escape/new.txt',
      content: 'blocked'
    })).rejects.toThrow('workspace');
  });

  it('creates directories, deletes files and empty dirs, and rejects escape', async () => {
    await command('workspace.mkdir', { path: 'uploads/docs' });
    await command('workspace.write', { path: 'uploads/docs/note.txt', content: 'ok' });
    await command('workspace.delete', { path: 'uploads/docs/note.txt' });
    await command('workspace.delete', { path: 'uploads/docs' });
    const listing = await command('workspace.list', { path: 'uploads' });
    expect(listing.entries).toEqual([]);

    await mkdir(join(root, 'links'));
    await symlink(outside, join(root, 'links', 'escape'));
    await expect(command('workspace.write', {
      path: 'links/escape/secret.txt',
      content: 'blocked'
    })).rejects.toThrow('workspace');
    await expect(command('workspace.delete', { path: 'links/escape' })).rejects.toThrow('workspace');
  });

  it('hides in-progress upload staging files from listings', async () => {
    await writeFile(join(root, '.partial.bin.uploading'), Buffer.from([1, 2]));
    const listing = await command('workspace.list', { path: '.' });
    expect(listing.entries).toEqual([]);
  });

  it('pulls an http object into the workspace and can push it back', async () => {
    const payload = Buffer.from('s3-bytes');
    let uploaded: Buffer | undefined;
    const { server, url } = await listen((request, response) => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(payload);
        return;
      }
      if (request.method === 'PUT') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          uploaded = Buffer.concat(chunks);
          response.writeHead(200);
          response.end();
        });
        return;
      }
      response.writeHead(405);
      response.end();
    });
    try {
      await command('workspace.write', { path: 'from-s3.bin', content: 'old' });
      const pulled = await command('workspace.pull', {
        path: 'from-s3.bin',
        url,
        totalSize: payload.byteLength,
        ifExists: 'rename'
      });
      expect(pulled).toMatchObject({ path: 'from-s3 (1).bin', size: payload.byteLength });
      expect(await readFile(join(root, 'from-s3.bin'), 'utf8')).toBe('old');
      expect(await readFile(join(root, 'from-s3 (1).bin'))).toEqual(payload);
      await command('workspace.push', {
        path: 'from-s3 (1).bin',
        url,
        mimeType: 'application/octet-stream'
      });
      expect(uploaded).toEqual(payload);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects non-http pull urls, foreign hosts, and path escape', async () => {
    await expect(command('workspace.pull', {
      path: 'bad.bin',
      url: 'file:///etc/passwd',
      totalSize: 1
    })).rejects.toThrow('url');
    await expect(command('workspace.pull', {
      path: 'remote.bin',
      url: 'http://example.com/file.bin',
      totalSize: 1
    })).rejects.toThrow('host');
    await mkdir(join(root, 'links'));
    await symlink(outside, join(root, 'links', 'escape'));
    await expect(command('workspace.pull', {
      path: 'links/escape/secret.bin',
      url: 'http://127.0.0.1/file.bin',
      totalSize: 1
    })).rejects.toThrow('workspace');
  });

  it('allows pull only from APP_S3_ENDPOINT when it is set', async () => {
    const payload = Buffer.from('pinned');
    const { server, url } = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(payload);
    });
    process.env.APP_S3_ENDPOINT = 'http://minio:9000';
    try {
      await expect(command('workspace.pull', {
        path: 'denied.bin',
        url,
        totalSize: payload.byteLength
      })).rejects.toThrow('host');
      process.env.APP_S3_ENDPOINT = new URL(url).origin;
      const pulled = await command('workspace.pull', {
        path: 'allowed.bin',
        url,
        totalSize: payload.byteLength
      });
      expect(pulled).toMatchObject({ path: 'allowed.bin', size: payload.byteLength });
    } finally {
      await closeServer(server);
    }
  });
});
