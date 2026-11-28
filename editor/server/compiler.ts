import { spawn as spawnChild, type SpawnOptions } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CompileState } from '../shared/contracts.js';

type CompilerChild = Pick<EventEmitter, 'once'> & {
  pid?: number;
  stdout: Readable | null;
  stderr: Readable | null;
};

export interface CompilerOptions {
  spawn?: (command: string, args: string[], options: SpawnOptions) => CompilerChild;
  killGroup?: (pid: number) => void;
  timeoutMs?: number;
}

export interface Compiler {
  request(): void;
  state(): CompileState;
  subscribe(listener: (state: CompileState) => void): () => void;
  pdf(): Promise<{ stream: Readable; revision: string } | null>;
}

const commandArgs = [
  '-norc', '-pdf', '-interaction=nonstopmode', '-file-line-error', '-no-shell-escape',
  '-outdir=build/browser/work', 'main.tex',
];
const logLimit = 32_768;

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function openPdf(path: string): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const signature = Buffer.alloc(5);
    if (!(await file.stat()).isFile() ||
        (await file.read(signature, 0, signature.length, 0)).bytesRead !== signature.length ||
        signature.toString('ascii') !== '%PDF-') {
      throw new Error('Expected a regular PDF file');
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function revisionOf(file: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function createCompiler(projectRoot: string, options: CompilerOptions = {}): Promise<Compiler> {
  const root = resolve(projectRoot);
  const build = join(root, 'build');
  const browser = join(build, 'browser');
  const work = join(browser, 'work');
  const published = join(browser, 'last-good.pdf');
  const spawn = options.spawn ?? spawnChild;
  const killGroup = options.killGroup ?? killProcessGroup;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const listeners = new Set<(state: CompileState) => void>();
  let current: CompileState = { status: 'idle', log: '', pdfRevision: null };
  let running = false;
  let queued = false;

  async function checkDirectories(paths: string[], create = false): Promise<void> {
    for (const path of paths) {
      if (create) {
        await mkdir(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      }
      if (!(await lstat(path)).isDirectory()) {
        throw new Error('Expected a directory at ' + path);
      }
    }
  }

  async function openPublished(): Promise<FileHandle | null> {
    try {
      await checkDirectories([build, browser]);
      return await openPdf(published);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  const recovered = await openPublished();
  if (recovered) {
    try {
      current = { status: 'success', log: '', pdfRevision: await revisionOf(recovered) };
    } finally {
      await recovered.close();
    }
  }

  function update(change: Partial<CompileState>): void {
    current = { ...current, ...change };
    for (const listener of listeners) listener(current);
  }

  function appendLog(text: string): void {
    update({ log: (current.log + text).slice(-logLimit) });
  }

  function runLatex(): Promise<void> {
    return new Promise((resolveRun, rejectRun) => {
      const child = spawn('latexmk', [...commandArgs], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let failure: Error | undefined;

      function stopGroup(): void {
        try {
          if (child.pid !== undefined) killGroup(child.pid);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failure = new Error('Could not terminate the compiler process group: ' + message);
        }
      }

      const timer = setTimeout(() => {
        failure = new Error('Compilation timed out after ' + timeoutMs / 1_000 + ' seconds');
        stopGroup();
      }, timeoutMs);

      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding('utf8').on('data', appendLog);
      }
      child.once('error', (error: Error) => { failure ??= error; });
      child.once('close', (code: number | null) => {
        clearTimeout(timer);
        stopGroup();
        if (failure) rejectRun(failure);
        else if (code === 0) resolveRun();
        else rejectRun(new Error('latexmk exited with ' + (code ?? 'a signal')));
      });
    });
  }

  async function publish(): Promise<string> {
    await checkDirectories([build, browser, work]);
    const source = await openPdf(join(work, 'main.pdf'));
    const temporary = join(browser, '.publish-' + randomUUID());
    try {
      await pipeline(source.createReadStream({ start: 0 }), createWriteStream(temporary, { flags: 'wx' }));
      const snapshot = await openPdf(temporary);
      try {
        const revision = await revisionOf(snapshot);
        await rename(temporary, published);
        return revision;
      } finally {
        await snapshot.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async function drain(): Promise<void> {
    do {
      queued = false;
      update({ status: 'compiling', log: '' });
      try {
        await checkDirectories([build, browser, work], true);
        await runLatex();
        update({ status: 'success', pdfRevision: await publish() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendLog('\n' + message + '\n');
        update({ status: 'error' });
      }
    } while (queued);
    running = false;
  }

  return {
    request() {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      void drain();
    },
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      return () => { listeners.delete(listener); };
    },
    async pdf() {
      const file = await openPublished();
      if (!file) return null;
      try {
        const revision = await revisionOf(file);
        return { stream: file.createReadStream({ start: 0 }), revision };
      } catch (error) {
        await file.close();
        throw error;
      }
    },
  };
}
