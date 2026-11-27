import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

const allowedHosts = new Set(['localhost:3000', '127.0.0.1:3000']);
const readOnlyMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function createApp(_projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify();

  app.addHook('onRequest', async (request, reply) => {
    const { host, origin } = request.headers;
    if (!host || !allowedHosts.has(host)) {
      return reply.code(403).send({ error: 'Host is not allowed' });
    }

    if (!readOnlyMethods.has(request.method) && origin !== 'http://' + host) {
      return reply.code(403).send({ error: 'Origin is not allowed' });
    }
  });

  await app.register(fastifyStatic, { root: resolve('dist/client') });
  return app;
}
