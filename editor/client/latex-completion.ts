import { LSPClient, Workspace, serverCompletionSource, type WorkspaceFile } from '@codemirror/lsp-client';
import { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

class LatexDocuments extends Workspace {
  files: WorkspaceFile[] = [];
  private views = new Map<string, EditorView>();
  private drafts = new Map<string, string>();
  private nextVersion = 0;

  upsert(uri: string, languageId: string, text: string) {
    this.drafts.set(uri, text);
    if (this.getFile(uri)) return;
    const file = {
      uri, languageId, doc: asDocument(text), version: ++this.nextVersion,
      getView: () => this.views.get(uri) ?? null,
    };
    this.files.push(file);
    this.client.didOpen(file);
  }

  remove(uri: string) {
    this.drafts.delete(uri);
    this.files = this.files.filter(file => file.uri !== uri);
    this.client.didClose(uri);
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    this.views.set(uri, view);
    this.upsert(uri, languageId, view.state.doc.toString());
  }

  closeFile(uri: string, view: EditorView) {
    if (this.views.get(uri) === view) this.views.delete(uri);
  }

  syncFiles() {
    return this.files.flatMap(file => {
      const doc = file.getView()?.state.doc ?? asDocument(this.drafts.get(file.uri)!);
      if (file.doc.eq(doc)) return [];
      const prevDoc = file.doc;
      const changes = EditorState.create({ doc: prevDoc }).changes({
        from: 0, to: prevDoc.length, insert: doc,
      });
      file.doc = doc;
      file.version = ++this.nextVersion;
      return [{ file, changes, prevDoc }];
    });
  }
}

function asDocument(text: string) {
  return Text.of(text.split(/\r\n?|\n/));
}

export function createLatexCompletion(onConnectionChange: () => void) {
  const drafts = new Map<string, string>();
  let rootUri = '';
  let socket: WebSocket | undefined;
  let session: { client: LSPClient; documents: LatexDocuments } | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function uri(path: string) {
    return rootUri + '/' + path.split('/').map(encodeURIComponent).join('/');
  }

  function language(path: string) {
    return path.toLowerCase().endsWith('.bib') ? 'bibtex' : 'latex';
  }

  function connect() {
    if (socket || retry || !drafts.size) return;
    const url = new URL('/api/lsp', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = socket = new WebSocket(url);
    let receive: ((message: string) => void) | undefined;
    let client: LSPClient | undefined;
    connection.addEventListener('message', event => {
      if (socket !== connection) return;
      if (client) {
        receive?.(event.data);
        return;
      }
      ({ rootUri } = JSON.parse(event.data));
      const autocomplete: typeof serverCompletionSource = async context => {
        const line = context.state.doc.lineAt(context.pos);
        const prefix = context.state.sliceDoc(line.from, context.pos);
        if (!context.explicit && !/\\(?:[a-zA-Z@]*|[a-zA-Z@]+\{[^{}\s]*)$/.test(prefix)) return null;
        const result = await Promise.resolve(serverCompletionSource(context)).catch(() => null);
        if (!result || socket !== connection || context.aborted) return null;
        return {
          ...result,
          options: result.options.map(option => ({ ...option, info: undefined })),
        };
      };
      const languageData = [{ autocomplete }];
      const current = client = new LSPClient({
        rootUri,
        workspace: client => new LatexDocuments(client),
        extensions: [EditorState.languageData.of(() => languageData)],
      });
      current.connect({
        send: message => {
          if (connection.readyState === WebSocket.OPEN) connection.send(message);
        },
        subscribe: handler => { receive = handler; },
        unsubscribe: () => { receive = undefined; },
      });
      void current.initializing.then(() => {
        if (socket !== connection) return;
        const documents = current.workspace as LatexDocuments;
        for (const [path, text] of drafts) documents.upsert(uri(path), language(path), text);
        session = { client: current, documents };
        onConnectionChange();
      }, () => connection.close());
    });
    connection.addEventListener('close', () => {
      if (socket !== connection) return;
      socket = undefined;
      if (session) {
        session = undefined;
        onConnectionChange();
      }
      retry = setTimeout(() => { retry = undefined; connect(); }, 2000);
    });
  }

  return {
    extensionFor(path: string) {
      return session?.client.plugin(uri(path), language(path)) ?? [];
    },
    upsert(path: string, text: string) {
      drafts.set(path, text);
      session?.documents.upsert(uri(path), language(path), text);
      connect();
    },
    close(path: string) {
      if (drafts.delete(path)) session?.documents.remove(uri(path));
    },
    diskChanged(changes: { path: string; type: 1 | 2 | 3 }[]) {
      if (changes.length) session?.client.notification('workspace/didChangeWatchedFiles', {
        changes: changes.map(({ path, type }) => ({ uri: uri(path), type })),
      });
    },
    dispose() {
      clearTimeout(retry);
      retry = undefined;
      const connection = socket;
      socket = undefined;
      session = undefined;
      onConnectionChange();
      connection?.close();
    },
    resume: connect,
  };
}
