import type { CompileState } from '../shared/contracts.js';
import type { Preview } from './preview.js';
import type { Workspace } from './workspace.js';

export interface CompileControls {
  onSaved(): void;
}

const labels: Record<CompileState['status'], string> = {
  idle: 'Ready to compile',
  compiling: 'Compiling…',
  success: 'Compiled',
  error: 'Compilation failed',
};

function renderLog(root: HTMLElement, log: string, workspace: Workspace): void {
  const output = document.createElement('pre');
  for (const line of log.split('\n')) {
    const match = /^(?:\.\/|\/data\/)?([^:]+\.(?:tex|bib|sty|cls)):(\d+):/i.exec(line);
    const path = match?.[1];
    if (path && !path.includes('\\') && path.split('/').every((segment) => segment && !segment.startsWith('.'))) {
      const link = document.createElement('button');
      link.type = 'button';
      link.textContent = line;
      link.addEventListener('click', () => { void workspace.open(path, Number(match[2])); });
      output.append(link);
    } else {
      output.append(line);
    }
    output.append('\n');
  }
  root.replaceChildren(output);
}

export function mountCompileControls(root: HTMLElement, workspace: Workspace, preview: Preview): CompileControls {
  root.innerHTML = `
    <button type="button" class="compile-button">Compile</button>
    <label class="auto-compile"><input type="checkbox"> Auto-compile</label>
    <a class="pdf-download" href="/api/pdf" download="main.pdf" hidden>Download PDF</a>
    <span class="compile-status" role="status">Connecting…</span>
    <span class="compile-message" role="status"></span>
  `;
  const compileButton = root.querySelector('button')!;
  const auto = root.querySelector('input')!;
  const download = root.querySelector<HTMLAnchorElement>('a')!;
  const status = root.querySelector<HTMLElement>('.compile-status')!;
  const message = root.querySelector<HTMLElement>('.compile-message')!;
  const logRoot = root.ownerDocument.getElementById('compile-log');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastLog = '';
  let renderedLog: string | undefined;
  let revision: string | null = null;

  async function requestBuild(manual: boolean): Promise<void> {
    message.textContent = manual && workspace.hasUnsavedEdits() ? 'Compiling saved files. Unsaved edits are excluded.' : '';
    try {
      const response = await fetch('/api/compile', { method: 'POST' });
      if (!response.ok) throw new Error('Request failed (' + response.status + ')');
    } catch (error) {
      message.textContent = 'Could not start compilation. ' + (error instanceof Error ? error.message : '');
    }
  }

  compileButton.addEventListener('click', () => {
    clearTimeout(timer);
    void requestBuild(true);
  });
  auto.addEventListener('change', () => { if (!auto.checked) clearTimeout(timer); });

  function updateLog(): void {
    if (!logRoot || renderedLog === lastLog) return;
    renderLog(logRoot, lastLog, workspace);
    renderedLog = lastLog;
  }

  logRoot?.addEventListener('focusout', (event) => {
    if (!logRoot.contains(event.relatedTarget as Node | null)) updateLog();
  });

  const events = new EventSource('/api/events');
  events.addEventListener('error', () => { status.textContent = 'Reconnecting…'; });
  events.addEventListener('state', (event: MessageEvent<string>) => {
    const state: CompileState = JSON.parse(event.data);
    status.textContent = labels[state.status];
    status.dataset.state = state.status;
    lastLog = state.log;
    if (!logRoot?.contains(root.ownerDocument.activeElement)) updateLog();
    if (state.pdfRevision && state.pdfRevision !== revision) {
      revision = state.pdfRevision;
      download.hidden = false;
      void preview.show(revision);
    }
  });

  return {
    onSaved() {
      if (!auto.checked) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void requestBuild(false); }, 1_500);
    },
  };
}
