import websocket from '@fastify/websocket';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ProjectFiles } from './project-files.js';

const limit = 8 * 1024 * 1024;
const methods = new Set([
  'initialize', 'initialized', 'textDocument/didOpen', 'textDocument/didChange',
  'textDocument/didClose', 'textDocument/completion', 'completionItem/resolve',
  'workspace/didChangeWatchedFiles', '$/cancelRequest',
]);

export async function registerLspRoutes(app: FastifyInstance, root: string, files: ProjectFiles) {
  await app.register(websocket, { options: { maxPayload: limit } });
  const rootUri = pathToFileURL(root).href.replace(/\/$/, '');

  app.get('/api/lsp', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (request.headers.origin !== 'http://' + request.headers.host) {
        return reply.code(403).send({ error: 'Origin is not allowed' });
      }
    },
  }, (socket) => {
    const child = spawn('texlab', [], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    let queue = Promise.resolve();
    let queuedBytes = 0;
    let incoming = Buffer.alloc(0);
    let length: number | undefined;
    let initialized = false;
    const open = new Set<string>();

    function stop() {
      socket.terminate();
      child.kill('SIGKILL');
    }

    function write(message: unknown) {
      const body = JSON.stringify(message);
      if (child.stdin.writableLength + Buffer.byteLength(body) > limit) return stop();
      child.stdin.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
    }

    async function validate(uri: string, allowMissing = false) {
      const path = relative(root, fileURLToPath(uri)).split(sep).join('/');
      if (!uri.startsWith(rootUri + '/') || uri.includes('?') || uri.includes('#')) {
        throw new Error('Invalid file URI');
      }
      await files.validateSource(path, allowMissing);
    }

    socket.on('close', stop);
    socket.on('error', stop);
    child.on('error', stop);
    child.on('exit', stop);
    child.stdin.on('error', stop);

    socket.on('message', (data: Buffer, binary: boolean) => {
      if (binary) return stop();
      const body = data.toString();
      const bytes = Buffer.byteLength(body);
      queuedBytes += bytes;
      if (queuedBytes > limit) return stop();
      queue = queue.then(async () => {
        if (socket.readyState !== 1) return;
        const message = JSON.parse(body);
        const { method, params, id } = message;
        if (message.jsonrpc !== '2.0' || !methods.has(method)) {
          if (id !== undefined) socket.send(JSON.stringify({
            jsonrpc: '2.0', id, error: { code: -32601, message: 'Method unavailable' },
          }));
          return;
        }
        if (method === 'initialize') {
          if (initialized || params.rootUri !== rootUri) throw new Error('Invalid workspace');
          initialized = true;
          message.params = { processId: null, rootUri, capabilities: params.capabilities };
        } else if (!initialized) {
          throw new Error('Workspace is uninitialized');
        } else if (method === 'workspace/didChangeWatchedFiles') {
          for (const change of params.changes) {
            await validate(change.uri, change.type === 3);
          }
        } else if (method.startsWith('textDocument/')) {
          const uri = params.textDocument.uri;
          if (method === 'textDocument/didOpen') {
            await validate(uri);
            open.add(uri);
          } else if (!open.has(uri)) {
            throw new Error('Document is not open');
          } else if (method === 'textDocument/didClose') {
            open.delete(uri);
          }
        }
        write(message);
      }).catch(stop).finally(() => { queuedBytes -= bytes; });
    });

    child.stdout.on('data', (chunk: Buffer) => {
      incoming = Buffer.concat([incoming, chunk]);
      try {
        while (incoming.length) {
          if (length === undefined) {
            const headerEnd = incoming.indexOf('\r\n\r\n');
            if (headerEnd < 0 && incoming.length < 4096) return;
            const header = /^Content-Length: (\d+)\r?$/im.exec(incoming.subarray(0, headerEnd).toString());
            if (headerEnd < 0 || !header) return stop();
            length = Number(header[1]);
            if (!length || length > limit) return stop();
            incoming = incoming.subarray(headerEnd + 4);
          }
          if (incoming.length < length) return;
          const body = incoming.subarray(0, length).toString();
          incoming = incoming.subarray(length);
          length = undefined;
          const message = JSON.parse(body);
          if (message.method && message.id !== undefined) {
            const response = message.method === 'workspace/configuration'
              ? { result: message.params.items.map(() => null) }
              : { error: { code: -32601, message: 'Method unavailable' } };
            write({ jsonrpc: '2.0', id: message.id, ...response });
          } else if (socket.readyState === 1) {
            if (socket.bufferedAmount + Buffer.byteLength(body) > limit) return stop();
            socket.send(body);
          }
        }
      } catch {
        stop();
      }
    });

    socket.send(JSON.stringify({ rootUri }));
  });
}
