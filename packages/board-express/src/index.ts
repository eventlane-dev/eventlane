import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BoardApi, type BoardOptions, createBoardApi } from '@eventlane/board-api';
import { uiDirectory } from '@eventlane/board-ui';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

export type { BoardOptions } from '@eventlane/board-api';

export interface Board {
  /** Mount it on any path: `app.use('/admin/events', board.router)`. */
  router: Router;
  /** The framework-neutral API behind the router. */
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

/**
 * Creates the board for Express: a router that serves the JSON API under `/api` and the web UI
 * everywhere else. It runs behind your own middleware, so put authentication before it.
 */
export function createBoard(options: BoardOptions): Board {
  const api = createBoardApi(options);
  const router = express.Router();

  let template: string | undefined;
  const page = (baseUrl: string): string => {
    template ??= readFileSync(join(uiDirectory, 'index.html'), 'utf8');
    // relative URLs in the page (assets, API calls) resolve against the mount path
    return template.replace('<head>', `<head><base href="${escapeAttribute(baseUrl)}/">`);
  };

  // writes carry a small JSON body; reads need no parsing
  const parseJson = express.json({ limit: '100kb' });
  router.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    parseJson(req, res, (error?: unknown) => {
      if (!error) return next();
      res.status(400).set('Cache-Control', 'no-store').json({ error: 'invalid JSON body' });
    });
  });

  router.use('/api', async (req: Request, res: Response) => {
    const response = await api.handle({
      method: req.method,
      path: req.path,
      query: req.query as Record<string, string | string[] | undefined>,
      headers: req.headers,
      body: req.body,
      raw: req,
      client: req.ip,
    });
    res
      .status(response.status)
      .set({ ...response.headers, 'Cache-Control': 'no-store' })
      .json(response.body);
  });

  router.use(express.static(uiDirectory, { index: false, maxAge: '1d' }));

  router.get('/', (req: Request, res: Response) => {
    res
      .type('html')
      .set({
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
      })
      .send(page(req.baseUrl));
  });

  return { router, api };
}
