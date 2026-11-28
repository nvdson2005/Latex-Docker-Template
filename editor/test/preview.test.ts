// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompileState } from '../shared/contracts.js';
import { mountCompileControls } from '../client/compile.js';
import { mountPreview } from '../client/preview.js';

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ getDocument, GlobalWorkerOptions: {} }));

class Events extends EventTarget {
  static last: Events;

  constructor() {
    super();
    Events.last = this;
  }

  send(state: CompileState) {
    this.dispatchEvent(new MessageEvent('state', { data: JSON.stringify(state) }));
  }
}

function documentWith(pages: number) {
  return {
    numPages: pages,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 300 * scale }),
      render: () => ({ promise: Promise.resolve() }),
    })),
  };
}

function loading(pages: number) {
  let resolve!: (value: ReturnType<typeof documentWith>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof documentWith>>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const task = { promise, destroy: vi.fn(async () => {}) };
  getDocument.mockReturnValueOnce(task);
  const pdf = documentWith(pages);
  return { resolve: () => resolve(pdf), reject, pdf };
}

let root: HTMLElement;

beforeEach(() => {
  root = document.body.appendChild(document.createElement('div'));
  vi.stubGlobal('EventSource', Events);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 202 })));
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  getDocument.mockReset();
});

afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function controls() {
  const workspace = { open: vi.fn(), hasUnsavedEdits: vi.fn(() => false), saveActive: vi.fn(), refresh: vi.fn() };
  const preview = { show: vi.fn(async () => {}) };
  return { workspace, preview, ...mountCompileControls(root, workspace, preview) };
}

it('debounces successful saves only while auto-compile is enabled', async () => {
  vi.useFakeTimers();
  const compile = controls();
  const toggle = root.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(toggle.checked).toBe(false);
  compile.onSaved();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(fetch).not.toHaveBeenCalled();

  toggle.click();
  compile.onSaved();
  await vi.advanceTimersByTimeAsync(1_000);
  compile.onSaved();
  await vi.advanceTimersByTimeAsync(1_499);
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/compile', { method: 'POST' });

  compile.onSaved();
  toggle.click();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('links source diagnostics and retains plain compiler output', () => {
  const log = document.body.appendChild(document.createElement('div'));
  log.id = 'compile-log';
  try {
    const { workspace, preview } = controls();
    Events.last.send({
      status: 'error',
      log: './sections/intro.tex:12: Undefined control sequence.\npdflatex exited with 1\n',
      pdfRevision: 'existing',
    });
    const diagnostic = log.querySelector('button')!;
    expect(diagnostic.textContent).toBe('./sections/intro.tex:12: Undefined control sequence.');
    diagnostic.click();
    expect(workspace.open).toHaveBeenCalledWith('sections/intro.tex', 12);
    expect(log.textContent).toContain('pdflatex exited with 1');
    expect(log.querySelectorAll('button')).toHaveLength(1);
    expect(preview.show).toHaveBeenCalledExactlyOnceWith('existing');
    expect(root.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe('/api/pdf');
  } finally {
    log.remove();
  }
});

it('keeps the newest PDF visible when an older load resolves or a subsequent load fails', async () => {
  const preview = mountPreview(root);
  const old = loading(1);
  const olderRequest = preview.show('old');
  const latest = loading(2);
  const newerRequest = preview.show('new');
  latest.resolve();
  await newerRequest;
  old.resolve();
  await olderRequest;
  expect(root.querySelector('.pdf-pages')?.getAttribute('data-revision')).toBe('new');

  const failed = loading(3);
  const failedRequest = preview.show('missing');
  failed.reject(new Error('Load failed'));
  await failedRequest;
  expect(root.querySelector('.pdf-pages')?.getAttribute('data-revision')).toBe('new');
  expect(root.textContent).toContain('Load failed');
});

it('clamps the reading anchor to the remaining pages and keeps the current zoom', async () => {
  const preview = mountPreview(root);
  const first = loading(3);
  const showing = preview.show('first');
  first.resolve();
  await showing;
  const zoom = loading(3);
  root.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click();
  zoom.resolve();
  await vi.waitFor(() => expect(root.querySelector('.pdf-page')?.getAttribute('style')).toContain('250px'));

  const scroll = root.querySelector<HTMLElement>('.pdf-scroll')!;
  const pages = [...root.querySelectorAll<HTMLElement>('.pdf-page')];
  pages.forEach((page, index) => {
    Object.defineProperty(page, 'offsetTop', { value: index * 400 });
    Object.defineProperty(page, 'offsetHeight', { value: 375 });
  });
  scroll.scrollTop = 850;

  const shorter = loading(1);
  const replacing = preview.show('shorter');
  shorter.resolve();
  await replacing;
  expect(root.querySelectorAll('.pdf-page')).toHaveLength(1);
  expect(root.querySelector('.pdf-page')?.getAttribute('style')).toContain('250px');
  expect(scroll.scrollTop).toBe(50);
});
