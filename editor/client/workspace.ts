import { basicSetup } from 'codemirror';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { TextFile, TreeEntry } from '../shared/contracts.js';

export interface Workspace {
  open(path: string, line?: number): Promise<void>;
  hasUnsavedEdits(): boolean;
  saveActive(): Promise<void>;
  refresh(): Promise<void>;
}

type Buffer = { text: string; disk: TextFile; version: number; conflict?: TextFile };

function fileUrl(path: string): string {
  return '/api/file?path=' + encodeURIComponent(path);
}

function send(url: string, method: string, body?: object): Promise<Response> {
  return fetch(url, body === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function check(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message ?? body?.error ?? 'Request failed (' + response.status + ')');
  }
  return response;
}

function contains(parent: string, path: string): boolean {
  return parent === path || path.startsWith(parent + '/');
}

function button(text: string, action: () => void, label?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  if (label) element.setAttribute('aria-label', label);
  element.addEventListener('click', action);
  return element;
}

export function mountWorkspace(root: HTMLElement, onSaved: () => void): Workspace {
  root.classList.add('latex-workspace');
  root.innerHTML = `
    <header class="toolbar">
      <h1>LaTeX Workspace</h1>
      <button type="button" data-save disabled>Save</button>
      <div id="compile-controls"></div>
      <p class="workspace-error" role="alert" hidden></p>
    </header>
    <div class="workspace-body">
      <aside class="project-panel" aria-label="Project files">
        <div class="panel-heading"><h2>Project</h2><div class="file-actions"></div></div>
        <nav class="file-tree" aria-label="Project tree"></nav>
      </aside>
      <div class="work-panes">
        <section class="source-pane" id="source-pane" aria-label="Source editor">
          <div class="panel-heading source-heading">
            <h2 class="active-path">No file open</h2>
            <span class="save-state" role="status"></span>
          </div>
          <div class="save-conflict" hidden></div>
          <div class="editor-host"></div>
        </section>
        <div class="pane-divider" role="separator" tabindex="0"
          aria-label="Resize source and PDF panes" aria-controls="source-pane"
          aria-orientation="vertical" aria-valuemin="20" aria-valuemax="80" aria-valuenow="52"></div>
        <section class="preview-pane" aria-label="PDF preview">
          <div class="panel-heading"><h2>PDF preview</h2></div>
          <div id="pdf-preview"></div>
        </section>
      </div>
    </div>
    <details class="compile-log"><summary>Compile log</summary><div id="compile-log"></div></details>
  `;

  const tree = root.querySelector<HTMLElement>('.file-tree')!;
  const fileActions = root.querySelector<HTMLElement>('.file-actions')!;
  const editorHost = root.querySelector<HTMLElement>('.editor-host')!;
  const saveButton = root.querySelector<HTMLButtonElement>('[data-save]')!;
  const activePath = root.querySelector<HTMLElement>('.active-path')!;
  const saveState = root.querySelector<HTMLElement>('.save-state')!;
  const errorBox = root.querySelector<HTMLElement>('.workspace-error')!;
  const conflictBox = root.querySelector<HTMLElement>('.save-conflict')!;
  const buffers = new Map<string, Buffer>();
  const expanded = new Set<string>();
  let entries: TreeEntry[] = [];
  let active: string | undefined;
  let busy = false;
  let openRequest = 0;
  let treeRequest = 0;
  let diskGeneration = 0;

  function activeBuffer(): Buffer | undefined {
    return active === undefined ? undefined : buffers.get(active);
  }

  function hasUnsavedEdits(): boolean {
    return [...buffers.values()].some((buffer) => buffer.text !== buffer.disk.text);
  }

  function showError(error?: unknown): void {
    errorBox.textContent = error instanceof Error ? error.message : error ? String(error) : '';
    errorBox.hidden = !errorBox.textContent;
  }

  function updateHeader(): void {
    const buffer = activeBuffer();
    activePath.textContent = active ?? 'No file open';
    saveState.textContent = buffer && buffer.text !== buffer.disk.text ? 'Unsaved' : '';
    saveButton.disabled = busy || !buffer || buffer.text === buffer.disk.text;
    for (const action of root.querySelectorAll<HTMLButtonElement>('[data-file-action]')) {
      action.disabled = busy;
    }
    for (const item of tree.querySelectorAll<HTMLButtonElement>('[data-source]')) {
      if (item.dataset.source === active) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
      const file = buffers.get(item.dataset.source!);
      item.toggleAttribute('data-dirty', !!file && file.text !== file.disk.text);
      if (item.hasAttribute('data-dirty')) item.setAttribute('aria-label', item.textContent + ', unsaved');
      else item.removeAttribute('aria-label');
    }
  }

  function renderConflict(): void {
    const buffer = activeBuffer();
    const conflict = buffer?.conflict;
    conflictBox.replaceChildren();
    conflictBox.hidden = !conflict;
    if (!buffer || !conflict) return;
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    message.textContent = 'This file changed on disk. Reload the disk copy or retry against the version shown below.';
    const diskText = document.createElement('pre');
    diskText.tabIndex = 0;
    diskText.setAttribute('aria-label', 'Disk contents');
    diskText.textContent = conflict.text;
    const actions = document.createElement('div');
    actions.className = 'conflict-actions';
    actions.append(
      fileAction('Reload disk copy', () => {
        buffer.text = conflict.text;
        buffer.disk = conflict;
        buffer.version++;
        delete buffer.conflict;
        showBuffer();
        editor.focus();
      }),
      fileAction('Retry save', () => { void saveActive(conflict.revision); }),
    );
    conflictBox.append(message, actions, diskText);
    updateHeader();
  }

  const editor = new EditorView({ parent: editorHost });

  function showBuffer(): void {
    const buffer = activeBuffer();
    editor.setState(EditorState.create({
      doc: buffer?.text ?? '',
      extensions: [
        basicSetup,
        StreamLanguage.define(stex),
        EditorState.lineSeparator.of(buffer?.text.includes('\r\n') ? '\r\n' : '\n'),
        EditorState.readOnly.of(!buffer),
        EditorView.editable.of(!!buffer),
        EditorView.contentAttributes.of({ 'aria-label': 'LaTeX source' }),
        EditorView.updateListener.of((update) => {
          if (!buffer || !update.docChanged) return;
          buffer.text = update.state.sliceDoc();
          buffer.version++;
          updateHeader();
        }),
      ],
    }));
    updateHeader();
    renderConflict();
  }

  async function open(path: string, line?: number): Promise<void> {
    const request = ++openRequest;
    showError();
    try {
      let buffer = buffers.get(path);
      if (!buffer) {
        const disk: TextFile = await (await check(await fetch(fileUrl(path)))).json();
        if (request !== openRequest) return;
        buffer = { disk, text: disk.text, version: 0 };
        buffers.set(path, buffer);
      }
      if (active !== path) {
        active = path;
        showBuffer();
      }
      if (line !== undefined) {
        const position = editor.state.doc.line(Math.max(1, Math.min(line, editor.state.doc.lines))).from;
        editor.dispatch({ selection: { anchor: position }, scrollIntoView: true });
        editor.focus();
      }
    } catch (error) {
      if (request === openRequest) showError(error);
    }
  }

  async function mutate(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    updateHeader();
    showError();
    try {
      await action();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      updateHeader();
    }
  }

  async function saveActive(retryRevision?: string): Promise<void> {
    const path = active;
    const buffer = activeBuffer();
    if (!path || !buffer || buffer.text === buffer.disk.text) return;
    if (buffer.conflict && retryRevision === undefined) {
      conflictBox.querySelector('button')?.focus();
      return;
    }
    await mutate(async () => {
      const response = await send('/api/file', 'PUT', {
        path, text: buffer.text, revision: retryRevision ?? buffer.disk.revision,
      });
      if (response.status === 409) {
        const conflict = (await response.clone().json().catch(() => null))?.current as TextFile | undefined;
        if (conflict) {
          buffer.conflict = conflict;
          buffer.version++;
          if (active === path) renderConflict();
          return;
        }
      }
      const disk: TextFile = await (await check(response)).json();
      buffer.disk = disk;
      buffer.version++;
      delete buffer.conflict;
      if (active === path) renderConflict();
      onSaved();
    });
  }

  async function refreshBuffers(): Promise<void> {
    const generation = diskGeneration;
    await Promise.all([...buffers].map(async ([path, buffer]) => {
      if (buffer.text !== buffer.disk.text || busy) return;
      const version = buffer.version;
      const response = await fetch(fileUrl(path));
      if (response.status === 404) {
        if (buffers.get(path) !== buffer || buffer.version !== version || diskGeneration !== generation || busy) return;
        buffers.delete(path);
        if (active === path) {
          active = undefined;
          showBuffer();
        }
        return;
      }
      const disk: TextFile = await (await check(response)).json();
      if (buffers.get(path) !== buffer || buffer.version !== version || diskGeneration !== generation || busy) return;
      if (disk.revision === buffer.disk.revision) return;
      buffer.disk = disk;
      buffer.text = disk.text;
      buffer.version++;
      if (active === path) showBuffer();
    }));
  }

  async function refreshTree(): Promise<void> {
    const request = ++treeRequest;
    const next: TreeEntry[] = await (await check(await fetch('/api/files'))).json();
    if (request !== treeRequest) return;
    entries = next;
    renderTree();
  }

  async function refresh(): Promise<void> {
    try {
      await refreshTree();
      await refreshBuffers();
    } catch (error) {
      showError(error);
    }
  }

  function fileAction(text: string, action: () => void, label?: string): HTMLButtonElement {
    const element = button(text, action, label);
    element.dataset.fileAction = '';
    element.disabled = busy;
    return element;
  }

  async function create(kind: 'source' | 'directory'): Promise<void> {
    const path = window.prompt(kind === 'source' ? 'New source path, including its extension' : 'New folder path');
    if (!path?.trim()) return;
    await mutate(async () => {
      await check(await send('/api/files', 'POST', { path, kind }));
      for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
        expanded.add(path.slice(0, index));
      }
      if (kind === 'source') await open(path);
      await refreshTree();
    });
  }

  async function move(from: string): Promise<void> {
    const to = window.prompt('Rename or move to a project-relative path', from);
    if (!to?.trim() || to === from) return;
    await mutate(async () => {
      await check(await send('/api/files/move', 'POST', { from, to }));
      diskGeneration++;
      openRequest++;
      for (const [path, buffer] of [...buffers]) {
        if (!contains(from, path)) continue;
        buffers.delete(path);
        buffers.set(to + path.slice(from.length), buffer);
      }
      for (const path of [...expanded]) {
        if (!contains(from, path)) continue;
        expanded.delete(path);
        expanded.add(to + path.slice(from.length));
      }
      if (active && contains(from, active)) active = to + active.slice(from.length);
      updateHeader();
      await refreshTree();
    });
  }

  async function remove(path: string): Promise<void> {
    if (!window.confirm('Delete ' + path + ' and discard any unsaved edits it contains?')) return;
    await mutate(async () => {
      await check(await send(fileUrl(path), 'DELETE'));
      diskGeneration++;
      openRequest++;
      for (const key of buffers.keys()) if (contains(path, key)) buffers.delete(key);
      for (const key of expanded) if (contains(path, key)) expanded.delete(key);
      if (active && contains(path, active)) {
        active = undefined;
        showBuffer();
      }
      await refreshTree();
    });
  }

  function renderTree(): void {
    const focused = tree.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
    const lists = new Map<string, HTMLUListElement>();
    function list(path: string): HTMLUListElement {
      let result = lists.get(path);
      if (!result) {
        result = document.createElement('ul');
        lists.set(path, result);
      }
      return result;
    }

    for (const entry of entries) {
      const { path, kind } = entry;
      const slash = path.lastIndexOf('/');
      const name = path.slice(slash + 1);
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'file-row';
      const actions = document.createElement('span');
      actions.className = 'row-actions';
      const rename = fileAction('Rename', () => { void move(path); }, 'Rename or move ' + path);
      rename.dataset.focusKey = 'rename/' + path;
      const del = fileAction('Delete', () => { void remove(path); }, 'Delete ' + path);
      del.dataset.focusKey = 'delete/' + path;
      actions.append(rename, del);

      if (kind === 'directory') {
        const folder = document.createElement('details');
        folder.open = expanded.has(path);
        folder.addEventListener('toggle', () => {
          if (!folder.isConnected) return;
          if (folder.open) expanded.add(path);
          else expanded.delete(path);
        });
        const summary = document.createElement('summary');
        summary.textContent = name;
        summary.dataset.focusKey = 'entry/' + path;
        folder.append(summary, list(path));
        row.append(folder, actions);
      } else {
        const label = kind === 'source' ? button(name, () => { void open(path); }) : document.createElement('span');
        label.textContent = name;
        label.dataset.focusKey = 'entry/' + path;
        if (kind === 'source') label.dataset.source = path;
        row.append(label, actions);
      }

      item.append(row);
      list(slash < 0 ? '' : path.slice(0, slash)).append(item);
    }
    tree.replaceChildren(list(''));
    updateHeader();
    if (focused) {
      [...tree.querySelectorAll<HTMLElement>('[data-focus-key]')]
        .find((element) => element.dataset.focusKey === focused)?.focus();
    }
  }

  fileActions.append(
    fileAction('New file', () => { void create('source'); }),
    fileAction('New folder', () => { void create('directory'); }),
  );
  saveButton.addEventListener('click', () => { void saveActive(); });
  root.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveActive();
    }
  });
  window.addEventListener('focus', () => { if (root.isConnected) void refresh(); });
  window.addEventListener('beforeunload', (event) => {
    if (root.isConnected && hasUnsavedEdits()) {
      event.preventDefault();
      event.returnValue = true;
    }
  });

  const panes = root.querySelector<HTMLElement>('.work-panes')!;
  const divider = root.querySelector<HTMLElement>('.pane-divider')!;
  let split = 52;
  function resize(value: number): void {
    split = Math.round(Math.max(20, Math.min(80, value)));
    panes.style.setProperty('--source-share', split + '%');
    divider.setAttribute('aria-valuenow', String(split));
  }
  divider.addEventListener('keydown', (event) => {
    const positions: Record<string, number> = { ArrowLeft: split - 2, ArrowRight: split + 2, Home: 20, End: 80 };
    const position = positions[event.key];
    if (typeof position !== 'number') return;
    event.preventDefault();
    resize(position);
  });
  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    divider.setPointerCapture(event.pointerId);
    divider.focus();
  });
  divider.addEventListener('pointermove', (event) => {
    if (!divider.hasPointerCapture(event.pointerId)) return;
    const bounds = panes.getBoundingClientRect();
    resize((event.clientX - bounds.left) / bounds.width * 100);
  });

  showBuffer();
  return { open, saveActive, hasUnsavedEdits, refresh };
}
