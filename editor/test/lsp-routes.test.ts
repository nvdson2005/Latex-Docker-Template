import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn,
}));

const host = 'localhost:3000';
const headers = { host, origin: 'http://' + host };
let root: string;
let rootUri: string;
let app: FastifyInstance;
let children: ReturnType<typeof fakeChild>[];

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(),
  });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'latex-lsp-')));
  rootUri = pathToFileURL(root).href;
  await writeFile(join(root, 'main.tex'), '');
  await symlink(join(root, 'main.tex'), join(root, 'linked.tex'));
  children = [];
  spawn.mockReset().mockImplementation(() => {
    const child = fakeChild();
    children.push(child);
    return child;
  });
  app = await createApp(root);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

it.each([undefined, 'http://example.com'])('rejects origin %s before spawning', async origin => {
  await expect(app.injectWS('/api/lsp', { headers: { host, origin } })).rejects.toThrow('403');
  expect(spawn).not.toHaveBeenCalled();
});

async function connect() {
  const messages: unknown[] = [];
  const ws = await app.injectWS('/api/lsp', { headers }, {
    onInit(socket) {
      socket.on('message', data => messages.push(JSON.parse(data.toString())));
    },
  });
  const child = children.at(-1)!;
  const input: string[] = [];
  child.stdin.on('data', data => input.push(data.toString()));
  const send = (method: string, params: object, id?: number) =>
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
  send('initialize', { rootUri }, 1);
  await vi.waitFor(() => expect(input[0]).toContain('"method":"initialize"'));
  return { ws, child, messages, input, send };
}

it('frames UTF-8 messages in both directions and isolates socket lifetimes', async () => {
  const first = await connect();
  const second = await connect();
  expect(first.child).not.toBe(second.child);

  first.send('textDocument/didOpen', { textDocument: { uri: rootUri + '/main.tex', text: 'é' } });
  await vi.waitFor(() => expect(first.input).toHaveLength(2));
  const [header, body] = first.input[1].split('\r\n\r\n');
  expect(header).toBe('Content-Length: ' + Buffer.byteLength(body));

  const frame = (id: number) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id, result: 'é' });
    return Buffer.from('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
  };
  const one = frame(1);
  first.child.stdout.write(one.subarray(0, one.length - 3));
  first.child.stdout.write(Buffer.concat([one.subarray(one.length - 3), frame(2)]));
  await vi.waitFor(() => expect(first.messages).toEqual([
    { rootUri }, { jsonrpc: '2.0', id: 1, result: 'é' }, { jsonrpc: '2.0', id: 2, result: 'é' },
  ]));
  first.send('textDocument/build', {}, 3);
  await vi.waitFor(() => expect(first.messages.at(-1)).toMatchObject({ id: 3, error: { code: -32601 } }));
  expect(first.input).toHaveLength(2);
  first.ws.terminate();
  await vi.waitFor(() => expect(first.child.kill).toHaveBeenCalled());
  expect(second.child.kill).not.toHaveBeenCalled();
  const closed = once(second.ws, 'close');
  second.child.emit('exit');
  await closed;
});

it.each(['../outside.tex', 'editor/private.tex', 'linked.tex'])('rejects document %s', async path => {
  const { ws, send, input } = await connect();
  const closed = once(ws, 'close');
  send('textDocument/didOpen', { textDocument: { uri: rootUri + '/' + path, text: '' } });
  await closed;
  expect(input).toHaveLength(1);
});
