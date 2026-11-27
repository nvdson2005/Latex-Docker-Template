// @vitest-environment jsdom

import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TextFile, TreeEntry } from '../shared/contracts.js';
import { mountWorkspace } from '../client/workspace.js';

let root: HTMLElement;
let files: Map<string, TextFile>;
let entries: TreeEntry[];
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function response(body: unknown, status = 200) {
  return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
}

function view() {
  return EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
}

function write(text: string) {
  const editor = view();
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
}

function button(label: string) {
  const match = [...root.querySelectorAll('button')].find((element) =>
    element.textContent === label || element.getAttribute('aria-label') === label);
  if (!match) throw new Error('Missing button ' + label);
  return match;
}

beforeEach(() => {
  root = document.body.appendChild(document.createElement('main'));
  files = new Map([
    ['main.tex', { text: 'Main', revision: 'main-1' }],
    ['sections/intro.tex', { text: 'Intro', revision: 'intro-1' }],
  ]);
  entries = [
    { path: 'main.tex', kind: 'source' },
    { path: 'sections', kind: 'directory' },
    { path: 'sections/intro.tex', kind: 'source' },
  ];
  fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/files') return response(entries);
    return response(files.get(url.searchParams.get('path')!) ?? {}, files.has(url.searchParams.get('path')!) ? 200 : 404);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  view()?.destroy();
  root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps unsaved edits when switching files', async () => {
  const workspace = mountWorkspace(root, vi.fn());
  await workspace.open('main.tex');
  write('My draft');
  await workspace.open('sections/intro.tex');
  expect(view().state.doc.toString()).toBe('Intro');
  await workspace.open('main.tex');
  expect(view().state.doc.toString()).toBe('My draft');
  expect(workspace.hasUnsavedEdits()).toBe(true);
});

it('keeps edits typed while a save is pending and uses the returned revision next time', async () => {
  const onSaved = vi.fn();
  const workspace = mountWorkspace(root, onSaved);
  await workspace.open('main.tex');
  write('First draft');
  const pending = deferred<Response>();
  fetchMock.mockImplementationOnce(() => pending.promise);
  const saving = workspace.saveActive();
  write('Later draft');
  pending.resolve(response({ text: 'First draft', revision: 'main-2' }));
  await saving;
  expect(workspace.hasUnsavedEdits()).toBe(true);
  expect(view().state.doc.toString()).toBe('Later draft');
  expect(onSaved).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce(response({ text: 'Later draft', revision: 'main-3' }));
  await workspace.saveActive();
  const [, init] = fetchMock.mock.lastCall!;
  expect(JSON.parse(String(init?.body))).toEqual({ path: 'main.tex', text: 'Later draft', revision: 'main-2' });
  expect(workspace.hasUnsavedEdits()).toBe(false);
});

it('keeps a conflicting draft and retries only against the displayed revision', async () => {
  const workspace = mountWorkspace(root, vi.fn());
  await workspace.open('main.tex');
  write('My draft');
  fetchMock.mockResolvedValueOnce(response({ current: { text: 'First disk edit', revision: 'main-2' } }, 409));
  await workspace.saveActive();
  expect(view().state.doc.toString()).toBe('My draft');
  expect(root.textContent).toContain('First disk edit');

  fetchMock.mockResolvedValueOnce(response({ current: { text: 'Second disk edit', revision: 'main-3' } }, 409));
  button('Retry save').click();
  const [, init] = fetchMock.mock.lastCall!;
  expect(JSON.parse(String(init?.body)).revision).toBe('main-2');
  await vi.waitFor(() => expect(root.textContent).toContain('Second disk edit'));
  expect(view().state.doc.toString()).toBe('My draft');
  button('Reload disk copy').click();
  expect(workspace.hasUnsavedEdits()).toBe(false);
  expect(view().state.doc.toString()).toBe('Second disk edit');
});

it('remaps open descendants after a successful move response', async () => {
  const workspace = mountWorkspace(root, vi.fn());
  await workspace.refresh();
  await workspace.open('sections/intro.tex');
  write('Draft');
  vi.spyOn(window, 'prompt').mockReturnValue('chapters');
  const pending = deferred<Response>();
  fetchMock.mockImplementationOnce(() => pending.promise);
  button('Rename or move sections').click();
  expect(root.querySelector('.active-path')?.textContent).toBe('sections/intro.tex');
  entries = entries.map(({ path, kind }) => ({ path: path.replace(/^sections/, 'chapters'), kind }));
  pending.resolve(response(null, 204));
  await vi.waitFor(() => expect(root.querySelector('.active-path')?.textContent).toBe('chapters/intro.tex'));
  expect(view().state.doc.toString()).toBe('Draft');
  expect(workspace.hasUnsavedEdits()).toBe(true);
});

it('preserves buffers after cancel or failed delete and discards them after confirmed success', async () => {
  const workspace = mountWorkspace(root, vi.fn());
  await workspace.refresh();
  await workspace.open('sections/intro.tex');
  write('Draft');
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
  button('Delete sections').click();
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('unsaved'));
  expect(workspace.hasUnsavedEdits()).toBe(true);

  fetchMock.mockResolvedValueOnce(response({ message: 'Directory contains a protected entry' }, 403));
  button('Delete sections').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Directory contains a protected entry'));
  expect(view().state.doc.toString()).toBe('Draft');
  expect(workspace.hasUnsavedEdits()).toBe(true);

  entries = entries.slice(0, 1);
  fetchMock.mockResolvedValueOnce(response(null, 204));
  button('Delete sections').click();
  await vi.waitFor(() => expect(workspace.hasUnsavedEdits()).toBe(false));
  expect(root.querySelector('.active-path')?.textContent).toBe('No file open');
});

it('does not refresh over edits made while disk reads are pending', async () => {
  const workspace = mountWorkspace(root, vi.fn());
  await workspace.open('main.tex');
  const pending = deferred<Response>();
  fetchMock.mockResolvedValueOnce(response(entries)).mockImplementationOnce(() => pending.promise);
  const refreshing = workspace.refresh();
  await vi.waitFor(() => expect(fetchMock.mock.lastCall?.[0]).toContain('/api/file?'));
  write('Local edits');
  pending.resolve(response({ text: 'External edits', revision: 'main-2' }));
  await refreshing;
  expect(view().state.doc.toString()).toBe('Local edits');
  expect(workspace.hasUnsavedEdits()).toBe(true);
});

it('protects an unsaved destination draft after its disk entry disappears', async () => {
  const workspace = mountWorkspace(root, vi.fn());
  await workspace.refresh();
  await workspace.open('main.tex');
  write('Destination draft');
  files.delete('main.tex');
  entries = entries.filter(({ path }) => path !== 'main.tex');
  await workspace.refresh();
  await workspace.open('sections/intro.tex');
  vi.spyOn(window, 'prompt').mockReturnValue('main.tex');
  button('Rename or move sections/intro.tex').click();
  await vi.waitFor(() => expect(root.textContent).toContain('Choose a destination without an open file'));
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/files/move')).toBe(false);
  await workspace.open('main.tex');
  expect(view().state.doc.toString()).toBe('Destination draft');
});
