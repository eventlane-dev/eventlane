import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { type BoardApi, type BoardOptions, createBoardApi } from '@eventlane/board-api';
import { uiDirectory } from '@eventlane/board-ui';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export type { BoardOptions } from '@eventlane/board-api';

export interface Board {
  /** Register it with a prefix: `app.register(board.plugin, { prefix: '/admin/events' })`. */
  plugin: FastifyPluginAsync;
  /** The framework-neutral API behind the plugin. */
  api: BoardApi;
}

const escapeAttribute = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The UI loads only its own files and talks only to its own origin; nothing may frame it.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const WRITE_AND_READ_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Creates the board for Fastify: a plugin that serves the JSON API under `/api` and the web UI
 * everywhere else, below the prefix it is registered with. Put authentication in a hook of your
 * own before registering it, or use `authorize`.
 */
export function createBoard(options: BoardOptions): Board {
  const api = createBoardApi(options);

  const plugin: FastifyPluginAsync = async (fastify) => {
    let template: string | undefined;
    const indexHtml = async (): Promise<string> => {
      template ??= await readFile(resolve(uiDirectory, 'index.html'), 'utf8');
      // relative URLs in the page (assets, API calls) resolve against the mount path
      return template.replace('<head>', `<head><base href="${escapeAttribute(fastify.prefix)}/">`);
    };

    const sendIndex = async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.headers({
        'Content-Type': MIME_TYPES['.html'],
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
      });
      return reply.send(await indexHtml());
    };
    fastify.get('/', sendIndex);

    // a body that is not JSON is the caller's fault, in the same shape as every other error
    fastify.setErrorHandler((error, request, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== undefined && status >= 400 && status < 500) {
        return reply
          .status(status)
          .header('Cache-Control', 'no-store')
          .send({ error: status === 400 ? 'invalid JSON body' : (error as Error).message });
      }
      request.log.error(error);
      return reply
        .status(500)
        .header('Cache-Control', 'no-store')
        .send({ error: 'internal error' });
    });

    fastify.route({
      method: [...WRITE_AND_READ_METHODS],
      url: '/api/*',
      handler: async (request, reply) => {
        const rest = (request.params as { '*'?: string })['*'] ?? '';
        const response = await api.handle({
          method: request.method,
          path: `/${rest}`,
          query: request.query as Record<string, string | string[] | undefined>,
          headers: request.headers,
          body: request.body,
          raw: request,
          client: request.ip,
        });
        return reply
          .status(response.status)
          .headers({ ...response.headers, 'Cache-Control': 'no-store' })
          .send(response.body);
      },
    });

    // the built UI: hashed assets and the index page; nothing outside the UI directory
    fastify.get('/*', async (request, reply) => {
      const rest = (request.params as { '*'?: string })['*'] ?? '';
      if (rest === '' || rest === 'index.html') return sendIndex(request, reply);
      const file = resolve(uiDirectory, rest);
      if (!file.startsWith(`${uiDirectory}${sep}`))
        return reply.status(404).send({ error: 'not found' });
      try {
        if (!(await stat(file)).isFile()) throw new Error('not a file');
        const content = await readFile(file);
        return reply
          .headers({
            'Content-Type': MIME_TYPES[extname(file)] ?? 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'public, max-age=86400',
          })
          .send(content);
      } catch {
        return reply.status(404).send({ error: 'not found' });
      }
    });
  };

  return { plugin, api };
}
