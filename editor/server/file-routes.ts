import type { FastifyInstance } from 'fastify';
import { RevisionConflict, type ProjectFiles } from './project-files.js';

const pathField = { type: 'string', minLength: 1 };
const pathQuery = {
  type: 'object', required: ['path'], properties: { path: pathField },
};

export function registerFileRoutes(app: FastifyInstance, files: ProjectFiles): void {
  app.get('/api/files', async () => files.list());

  app.get<{ Querystring: { path: string } }>('/api/file', {
    schema: { querystring: pathQuery },
  }, async (request) => files.read(request.query.path));

  app.post<{ Body: { path: string; kind: 'source' | 'directory' } }>('/api/files', {
    schema: {
      body: {
        type: 'object', required: ['path', 'kind'],
        properties: { path: pathField, kind: { enum: ['source', 'directory'] } },
      },
    },
  }, async (request, reply) => {
    const { path, kind } = request.body;
    return reply.code(201).send(await files.create(path, kind));
  });

  app.put<{ Body: { path: string; text: string; revision: string } }>('/api/file', {
    schema: {
      body: {
        type: 'object', required: ['path', 'text', 'revision'],
        properties: { path: pathField, text: { type: 'string' }, revision: pathField },
      },
    },
  }, async (request, reply) => {
    const { path, text, revision } = request.body;
    try {
      return await files.save(path, text, revision);
    } catch (error) {
      if (error instanceof RevisionConflict) return reply.code(409).send({ current: error.current });
      throw error;
    }
  });

  app.post<{ Body: { from: string; to: string } }>('/api/files/move', {
    schema: {
      body: { type: 'object', required: ['from', 'to'], properties: { from: pathField, to: pathField } },
    },
  }, async (request, reply) => {
    await files.move(request.body.from, request.body.to);
    return reply.code(204).send();
  });

  app.delete<{ Querystring: { path: string } }>('/api/file', {
    schema: { querystring: pathQuery },
  }, async (request, reply) => {
    await files.remove(request.query.path);
    return reply.code(204).send();
  });
}
