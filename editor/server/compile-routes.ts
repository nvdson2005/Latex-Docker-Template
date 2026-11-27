import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Compiler } from './compiler.js';

export function registerCompileRoutes(app: FastifyInstance, compiler: Compiler): void {
  app.post('/api/compile', async (_request, reply) => {
    compiler.request();
    return reply.code(202).send();
  });

  app.get('/api/events', { exposeHeadRoute: false }, async (_request, reply) => {
    const events = new PassThrough({ highWaterMark: 256 * 1024 });
    const unsubscribe = compiler.subscribe((state) => {
      if (!events.write('event: state\ndata: ' + JSON.stringify(state) + '\n\n')) {
        events.destroy();
      }
    });
    events.once('close', unsubscribe);
    reply.raw.once('close', () => events.destroy());
    return reply.type('text/event-stream; charset=utf-8').header('Cache-Control', 'no-cache').send(events);
  });

  app.get<{ Querystring: { revision?: string } }>('/api/pdf', {
    schema: { querystring: { type: 'object', properties: { revision: { type: 'string' } } } },
  }, async (request, reply) => {
    const snapshot = await compiler.pdf();
    if (!snapshot) return reply.code(404).send({ error: 'No successful build yet' });

    const etag = '"' + snapshot.revision + '"';
    reply.header('Cache-Control', 'no-cache');
    if (request.query.revision !== undefined && request.query.revision !== snapshot.revision) {
      snapshot.stream.destroy();
      return reply.code(409).send({ error: 'PDF revision changed' });
    }
    reply.header('ETag', etag);
    if (request.headers['if-none-match']?.split(',').some((tag) => {
      const value = tag.trim();
      return value === '*' || value === etag || value === 'W/' + etag;
    })) {
      snapshot.stream.destroy();
      return reply.code(304).send();
    }
    return reply.type('application/pdf').send(snapshot.stream);
  });
}
