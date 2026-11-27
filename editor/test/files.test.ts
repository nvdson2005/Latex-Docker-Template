import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createApp } from '../server/app.js';

let fixture: string;
let root: string;
let app: FastifyInstance;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'latex-files-'));
  root = join(fixture, 'project');
  await mkdir(root);
  app = await createApp(root);
});

afterEach(async () => {
  await app.close();
  await rm(fixture, { recursive: true, force: true });
});

function request(method: InjectOptions['method'], url: string, payload?: object) {
  return app.inject({
    method, url, payload,
    headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
  });
}

function fileUrl(path: string) {
  return '/api/file?path=' + encodeURIComponent(path);
}

it('creates, reads, saves, lists, moves, and removes project entries', async () => {
  expect((await request('POST', '/api/files', { path: 'chapters', kind: 'directory' })).statusCode).toBe(201);
  const path = 'chapters/intro.tex';
  const created = await request('POST', '/api/files', { path, kind: 'source' });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual({ path, kind: 'source' });
  const empty = await request('GET', fileUrl(path));
  expect(empty.statusCode).toBe(200);
  expect(empty.json().text).toBe('');

  await chmod(join(root, path), 0o640);
  const mode = (await stat(join(root, path))).mode;
  const saved = await request('PUT', '/api/file', { path, text: 'Introduction', revision: empty.json().revision });
  expect(saved.statusCode).toBe(200);
  expect(saved.json().revision).not.toBe(empty.json().revision);
  expect((await stat(join(root, path))).mode).toBe(mode);
  expect((await request('GET', fileUrl(path))).json()).toEqual(saved.json());
  expect((await request('GET', '/api/files')).json()).toEqual([
    { path: 'chapters', kind: 'directory' },
    { path, kind: 'source' },
  ]);

  expect((await request('POST', '/api/files/move', { from: 'chapters', to: 'sections' })).statusCode).toBe(204);
  expect(await readFile(join(root, 'sections/intro.tex'), 'utf8')).toBe('Introduction');
  expect((await request('GET', fileUrl(path))).statusCode).toBe(404);
  expect((await request('DELETE', fileUrl('sections'))).statusCode).toBe(204);
  expect((await request('GET', '/api/files')).json()).toEqual([]);
});

it('preserves both entries on collisions and serializes competing creates', async () => {
  await writeFile(join(root, 'a.tex'), 'a');
  await writeFile(join(root, 'b.tex'), 'b');
  expect((await request('POST', '/api/files/move', { from: 'a.tex', to: 'b.tex' })).statusCode).toBe(409);
  expect(await readFile(join(root, 'a.tex'), 'utf8')).toBe('a');
  expect(await readFile(join(root, 'b.tex'), 'utf8')).toBe('b');
  const creates = await Promise.all(Array.from({ length: 2 }, () =>
    request('POST', '/api/files', { path: 'new.tex', kind: 'source' })));
  expect(creates.map(({ statusCode }) => statusCode).sort()).toEqual([201, 409]);
});

it('returns a fresh conflict on every stale save and preserves disk changes', async () => {
  const path = 'main.tex';
  await writeFile(join(root, path), 'original');
  const original = (await request('GET', fileUrl(path))).json();
  await writeFile(join(root, path), 'first edit');
  const first = await request('PUT', '/api/file', { path, text: 'browser edit', revision: original.revision });
  expect(first.statusCode).toBe(409);
  expect(first.json().current.text).toBe('first edit');
  await writeFile(join(root, path), 'second edit');
  const second = await request('PUT', '/api/file', { path, text: 'browser edit', revision: first.json().current.revision });
  expect(second.statusCode).toBe(409);
  expect(second.json().current.text).toBe('second edit');
  expect(second.json().current.revision).not.toBe(first.json().current.revision);
  expect(await readFile(join(root, path), 'utf8')).toBe('second edit');
});

it('protects hidden, reserved, external, and symlink paths on every operation', async () => {
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs/private.tex'), 'reserved');
  await writeFile(join(root, '.hidden.tex'), 'hidden');
  await writeFile(join(fixture, 'outside.tex'), 'outside');
  await symlink(fixture, join(root, 'link'));
  await writeFile(join(root, 'safe.tex'), 'safe');

  for (const [path, status] of [
    ['../outside.tex', 400],
    [join(fixture, 'outside.tex'), 400],
    ['.hidden.tex', 403],
    ['docs/private.tex', 403],
    ['DOCS/private.tex', 403],
    ['link/outside.tex', 403],
    ['link', 403],
  ] as const) {
    expect((await request('GET', fileUrl(path))).statusCode).toBe(status);
    expect((await request('DELETE', fileUrl(path))).statusCode).toBe(status);
    expect((await request('POST', '/api/files', { path, kind: 'source' })).statusCode).toBe(status);
    expect((await request('PUT', '/api/file', { path, text: 'changed', revision: 'stale' })).statusCode).toBe(status);
    expect((await request('POST', '/api/files/move', { from: path, to: 'new.tex' })).statusCode).toBe(status);
    expect((await request('POST', '/api/files/move', { from: 'safe.tex', to: path })).statusCode).toBe(status);
  }
  expect((await request('GET', '/api/files')).json()).toEqual([{ path: 'safe.tex', kind: 'source' }]);
  expect(await readFile(join(root, 'docs/private.tex'), 'utf8')).toBe('reserved');
  expect(await readFile(join(root, '.hidden.tex'), 'utf8')).toBe('hidden');
  expect(await readFile(join(fixture, 'outside.tex'), 'utf8')).toBe('outside');
  expect(await readFile(join(root, 'safe.tex'), 'utf8')).toBe('safe');
});

it.each(['hidden', 'symlink'])('protects folders containing a nested %s entry', async (kind) => {
  const folder = join(root, 'chapters/nested');
  await mkdir(folder, { recursive: true });
  const protectedPath = join(folder, kind === 'hidden' ? '.keep' : 'link');
  if (kind === 'hidden') await writeFile(protectedPath, 'protected');
  else await symlink(fixture, protectedPath);
  expect((await request('DELETE', fileUrl('chapters'))).statusCode).toBe(403);
  expect((await request('POST', '/api/files/move', { from: 'chapters', to: 'sections' })).statusCode).toBe(403);
  expect((await stat(folder)).isDirectory()).toBe(true);
  expect((await request('GET', '/api/files')).json()).toEqual([
    { path: 'chapters', kind: 'directory' },
    { path: 'chapters/nested', kind: 'directory' },
  ]);
});

it('validates request shapes, extensions and text bytes', async () => {
  await writeFile(join(root, 'image.png'), Buffer.of(0, 255));
  await writeFile(join(root, 'broken.tex'), Buffer.of(255));
  expect((await request('GET', fileUrl('image.png'))).statusCode).toBe(400);
  expect((await request('GET', fileUrl('broken.tex'))).statusCode).toBe(400);
  expect((await request('PUT', '/api/file', { path: 'broken.tex', text: 'replacement', revision: 'stale' })).statusCode).toBe(400);
  expect(await readFile(join(root, 'broken.tex'))).toEqual(Buffer.of(255));
  expect((await request('GET', '/api/file')).statusCode).toBe(400);
  expect((await request('POST', '/api/files', { path: 'image2.png', kind: 'source' })).statusCode).toBe(400);
  expect((await request('POST', '/api/files', { path: 42, kind: 'directory' })).statusCode).toBe(400);
  expect((await request('POST', '/api/files/move', { from: 'broken.tex', to: 'broken.png' })).statusCode).toBe(400);
  expect((await request('POST', '/api/files/move', { from: 'image.png', to: 'renamed.png' })).statusCode).toBe(204);
  expect(await readFile(join(root, 'renamed.png'))).toEqual(Buffer.of(0, 255));
});
