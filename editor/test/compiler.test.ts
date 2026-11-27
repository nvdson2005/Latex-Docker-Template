import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCompiler, type CompilerOptions } from '../server/compiler.js';
import { registerCompileRoutes } from '../server/compile-routes.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor(readonly pid: number) {
    super();
  }

  finish(code: number | null) {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code);
  }
}

let root: string;
const pdfBytes = Buffer.from('%PDF-1.7\nfirst PDF\n');

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'latex-compiler-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function fakeProcess() {
  const children: FakeChild[] = [];
  const spawn = vi.fn<NonNullable<CompilerOptions['spawn']>>(() => {
    const child = new FakeChild(100 + children.length);
    children.push(child);
    return child;
  });
  const killGroup = vi.fn();
  return { children, spawn, killGroup };
}

it('coalesces triggers and waits for the timed-out process to close after group termination', async () => {
  const { children, spawn, killGroup } = fakeProcess();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const compiler = await createCompiler(root, { spawn, killGroup, timeoutMs: 25 });
  compiler.request();
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1), { interval: 1 });
  expect(spawn).toHaveBeenCalledWith('latexmk', [
    '-norc', '-pdf', '-interaction=nonstopmode', '-file-line-error', '-no-shell-escape',
    '-outdir=build/browser/work', 'main.tex',
  ], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  compiler.request();
  compiler.request();
  compiler.request();
  await vi.advanceTimersByTimeAsync(25);
  expect(killGroup).toHaveBeenCalledWith(children[0].pid);
  expect(spawn).toHaveBeenCalledTimes(1);
  children[0].finish(null);
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2), { interval: 1 });
  children[1].finish(1);
  await vi.waitFor(() => expect(compiler.state().status).toBe('error'), { interval: 1 });
  expect(spawn).toHaveBeenCalledTimes(2);
});

it('keeps the last successful bytes after failure and restart and streams an immutable snapshot', async () => {
  const { children, spawn, killGroup } = fakeProcess();
  const compiler = await createCompiler(root, { spawn, killGroup });
  const workPdf = join(root, 'build/browser/work/main.pdf');
  expect(await compiler.pdf()).toBeNull();
  compiler.request();
  await vi.waitFor(() => expect(children).toHaveLength(1));
  await writeFile(workPdf, pdfBytes);
  children[0].finish(0);
  await vi.waitFor(() => expect(compiler.state().status).toBe('success'));
  const firstRevision = compiler.state().pdfRevision;
  const original = await compiler.pdf();

  compiler.request();
  await vi.waitFor(() => expect(children).toHaveLength(2));
  await writeFile(workPdf, '%PDF-1.7\nfailed run');
  children[1].finish(1);
  await vi.waitFor(() => expect(compiler.state().status).toBe('error'));
  expect(compiler.state().pdfRevision).toBe(firstRevision);
  expect(await readFile(join(root, 'build/browser/last-good.pdf'))).toEqual(pdfBytes);
  const restarted = await createCompiler(root);
  expect(restarted.state().pdfRevision).toBe(firstRevision);

  compiler.request();
  await vi.waitFor(() => expect(children).toHaveLength(3));
  await writeFile(workPdf, '%PDF-1.7\nnew successful run');
  children[2].finish(0);
  await vi.waitFor(() => expect(compiler.state().status).toBe('success'));
  expect(compiler.state().pdfRevision).not.toBe(firstRevision);
  expect(original?.revision).toBe(firstRevision);
  expect(await original?.stream.toArray().then(Buffer.concat)).toEqual(pdfBytes);
});

it('delivers current state to a late SSE client and rejects stale PDF URLs', async () => {
  const { children, spawn, killGroup } = fakeProcess();
  const compiler = await createCompiler(root, { spawn, killGroup });
  const app = Fastify();
  registerCompileRoutes(app, compiler);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });

  try {
    expect((await app.inject('/api/pdf')).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/compile', method: 'POST' })).statusCode).toBe(202);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await writeFile(join(root, 'build/browser/work/main.pdf'), pdfBytes);
    children[0].finish(0);
    await vi.waitFor(() => expect(compiler.state().status).toBe('success'));
    const revision = compiler.state().pdfRevision;
    const pdf = await app.inject('/api/pdf?revision=' + revision);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers.etag).toBe('"' + revision + '"');
    expect(pdf.headers['cache-control']).toBe('no-cache');
    expect(pdf.rawPayload).toEqual(pdfBytes);
    expect((await app.inject('/api/pdf?revision=stale')).statusCode).toBe(409);

    const request = get(address + '/api/events');
    try {
      const [response] = await once(request, 'response');
      expect(response.headers['content-type']).toContain('text/event-stream');
      const [frame] = await once(response, 'data');
      expect(frame.toString()).toBe('event: state\ndata: ' + JSON.stringify(compiler.state()) + '\n\n');
    } finally {
      request.destroy();
    }
  } finally {
    await app.close();
  }
});

it('refuses to compile through a symlink in the work path', async () => {
  const { spawn, killGroup } = fakeProcess();
  const compiler = await createCompiler(root, { spawn, killGroup });
  await mkdir(join(root, 'build/browser'), { recursive: true });
  await symlink(root, join(root, 'build/browser/work'));
  compiler.request();
  await vi.waitFor(() => expect(compiler.state().status).toBe('error'));
  expect(compiler.state().log).toMatch(/directory/);
  expect(spawn).not.toHaveBeenCalled();
});
