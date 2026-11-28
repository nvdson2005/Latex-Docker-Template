import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerCompileRoutes } from './compile-routes.js';
import { createCompiler } from './compiler.js';
import { registerFileRoutes } from './file-routes.js';
import { createProjectFiles } from './project-files.js';

import { registerLspRoutes } from './lsp-routes.js';

const allowedHosts = new Set(['localhost:3000', '127.0.0.1:3000']);
const readOnlyMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function createApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ ajv: { customOptions: { coerceTypes: false } } });

  app.addHook('onRequest', async (request, reply) => {
    const { host, origin } = request.headers;
    if (!host || !allowedHosts.has(host)) {
      return reply.code(403).send({ error: 'Host is not allowed' });
    }

    if (!readOnlyMethods.has(request.method) && origin !== 'http://' + host) {
      return reply.code(403).send({ error: 'Origin is not allowed' });
    }
  });

  const root = await realpath(projectRoot);
  const files = createProjectFiles(root);
  registerFileRoutes(app, files);
  await registerLspRoutes(app, root, files);
  registerCompileRoutes(app, await createCompiler(projectRoot));
  await app.register(fastifyStatic, { root: resolve('dist/client') });
  return app;
}
