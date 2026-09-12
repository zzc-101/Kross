import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleWorkspaceCommand } from './workspaceCommands';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'app-workspace-command-'));
  outside = await mkdtemp(join(tmpdir(), 'app-workspace-outside-'));
});

afterEach(async () => {
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

  it('puts binary chunks, renames collisions, and reads them back', async () => {
    await command('workspace.write', { path: 'report.bin', content: 'old' });
    const bytes = Buffer.from([0, 1, 2, 3, 4]);
    const first = await command('workspace.put', {
      path: 'report.bin',
      offset: 0,
      data: bytes.subarray(0, 3).toString('base64'),
      eof: false,
      totalSize: bytes.byteLength,
      ifExists: 'rename'
    });
    expect(first.path).toBe('report (1).bin');
    const done = await command('workspace.put', {
      path: first.path,
      offset: 3,
      data: bytes.subarray(3).toString('base64'),
      eof: true,
      totalSize: bytes.byteLength
    });
    expect(done).toMatchObject({ path: 'report (1).bin', size: 5 });
    expect(await readFile(join(root, 'report (1).bin'))).toEqual(bytes);
    expect(await readFile(join(root, 'report.bin'), 'utf8')).toBe('old');

    const chunk = await command('workspace.get', {
      path: 'report (1).bin',
      offset: 0,
      length: 2
    });
    expect(chunk).toMatchObject({ size: 5, offset: 0, eof: false });
    expect(Buffer.from(String(chunk.data), 'base64')).toEqual(Buffer.from([0, 1]));
  });

  it('creates directories, deletes files and empty dirs, and rejects escape', async () => {
    await command('workspace.mkdir', { path: 'uploads/docs' });
    await command('workspace.put', {
      path: 'uploads/docs/note.bin',
      offset: 0,
      data: Buffer.from('ok').toString('base64'),
      eof: true,
      totalSize: 2
    });
    await command('workspace.delete', { path: 'uploads/docs/note.bin' });
    await command('workspace.delete', { path: 'uploads/docs' });
    const listing = await command('workspace.list', { path: 'uploads' });
    expect(listing.entries).toEqual([]);

    await mkdir(join(root, 'links'));
    await symlink(outside, join(root, 'links', 'escape'));
    await expect(command('workspace.put', {
      path: 'links/escape/secret.bin',
      offset: 0,
      data: Buffer.from('x').toString('base64'),
      eof: true
    })).rejects.toThrow('workspace');
    await expect(command('workspace.delete', { path: 'links/escape' })).rejects.toThrow('workspace');
  });

  it('hides in-progress upload staging files from listings', async () => {
    await command('workspace.put', {
      path: 'partial.bin',
      offset: 0,
      data: Buffer.from([1, 2]).toString('base64'),
      eof: false,
      totalSize: 4
    });
    const names = await readdir(root);
    expect(names.some((name) => name.endsWith('.uploading'))).toBe(true);
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
      const pulled = await command('workspace.pull', {
        path: 'from-s3.bin',
        url,
        totalSize: payload.byteLength,
        ifExists: 'rename'
      });
      expect(pulled).toMatchObject({ path: 'from-s3.bin', size: payload.byteLength });
      expect(await readFile(join(root, 'from-s3.bin'))).toEqual(payload);
      await command('workspace.push', {
        path: 'from-s3.bin',
        url,
        mimeType: 'application/octet-stream'
      });
      expect(uploaded).toEqual(payload);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects non-http pull urls and path escape', async () => {
    await expect(command('workspace.pull', {
      path: 'bad.bin',
      url: 'file:///etc/passwd',
      totalSize: 1
    })).rejects.toThrow('url');
    await mkdir(join(root, 'links'));
    await symlink(outside, join(root, 'links', 'escape'));
    await expect(command('workspace.pull', {
      path: 'links/escape/secret.bin',
      url: 'http://127.0.0.1/file.bin',
      totalSize: 1
    })).rejects.toThrow('workspace');
  });
});
