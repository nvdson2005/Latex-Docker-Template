import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../server/app.js';

describe('workspace request boundary', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp('/data');
    app.post('/test-write', async () => ({ accepted: true }));
  });

  afterAll(async () => app?.close());

  it.each(['localhost:3000', '127.0.0.1:3000'])('serves workspace HTML at %s', async (host) => {
    const response = await app.inject({ url: '/', headers: { host } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('LaTeX Workspace');
  });

  it('rejects an external host', async () => {
    const response = await app.inject({ url: '/', headers: { host: 'other.example:3000' } });
    expect(response.statusCode).toBe(403);
  });

  it.each(['localhost:3000', '127.0.0.1:3000'])('allows a same-origin write at %s', async (host) => {
    const response = await app.inject({
      method: 'POST', url: '/test-write', headers: { host, origin: 'http://' + host },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
  });

  it.each(['http://other.example:3000', 'http://127.0.0.1:3000', undefined])(
    'rejects a write with origin %s on localhost',
    async (origin) => {
      const headers = origin ? { origin, host: 'localhost:3000' } : { host: 'localhost:3000' };
      const response = await app.inject({ method: 'POST', url: '/test-write', headers });
      expect(response.statusCode).toBe(403);
    },
  );
});
