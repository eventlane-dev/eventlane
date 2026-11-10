import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventLaneBus } from '@eventlane/core';
import express from 'express';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createBoard } from '../src';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6390';
const prefix = `x-${randomBytes(4).toString('hex')}`;
const raw = new Redis(REDIS_URL);
// biome-ignore lint/suspicious/noExplicitAny: test helper over loosely typed JSON responses
type Json = Record<string, any>;
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  const keys = await raw.keys(`${prefix}*`);
  if (keys.length > 0) await raw.del(...keys);
});
afterAll(async () => {
  await raw.quit();
});

async function start(mountAt: string, options: Partial<Parameters<typeof createBoard>[0]> = {}) {
  const bus = new EventLaneBus({ redisUrl: REDIS_URL, prefix });
  const board = createBoard({ buses: bus, ...options });
  const app = express();
  app.use(mountAt, board.router);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  closers.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await bus.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    bus,
    origin,
    url: (path: string) => `${origin}${mountAt === '/' ? '' : mountAt}${path}`,
  };
}

describe('serving the UI', () => {
  it('serves the page under the mount path with a matching <base>, and its assets', async () => {
    const { url } = await start('/admin/events');
    for (const path of ['', '/']) {
      const response = await fetch(url(path));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const html = await response.text();
      expect(html).toContain('<base href="/admin/events/">');

      const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(html)?.[1];
      const style = /href="\.\/(assets\/[^"]+\.css)"/.exec(html)?.[1];
      expect(script).toBeDefined();
      expect(style).toBeDefined();
      const asset = await fetch(url(`/${script}`));
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toContain('javascript');
      expect((await fetch(url(`/${style}`))).status).toBe(200);
    }
    expect((await fetch(url('/nope.txt'))).status).toBe(404);
  });

  it('works mounted at the root', async () => {
    const { url } = await start('/');
    const html = await (await fetch(url('/'))).text();
    expect(html).toContain('<base href="/">');
  });
});

describe('the API', () => {
  it('serves JSON from the bus under /api and never caches it', async () => {
    const { url, bus } = await start('/admin/events');
    await bus.emit('users', 'user.created', { id: 1 });

    const config = await fetch(url('/api/config'));
    expect(config.headers.get('cache-control')).toBe('no-store');
    expect(await config.json()).toEqual({
      readOnly: true,
      hidePayloads: false,
      buses: ['default'],
    });

    const topics = (await (await fetch(url('/api/topics'))).json()) as Json;
    expect(topics.topics).toEqual([expect.objectContaining({ topicName: 'users', length: 1 })]);

    const events = (await (await fetch(url('/api/topics/users/events?limit=5'))).json()) as Json;
    expect(events.events[0]).toMatchObject({ eventName: 'user.created', preview: '{"id":1}' });

    const bad = await fetch(url('/api/topics/users/events?limit=0'));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: expect.stringContaining('limit') });
    expect((await fetch(url('/api/nothing'))).status).toBe(404);
  });

  it('rate limits per client and says when to come back', async () => {
    const { url } = await start('/admin/events', { rateLimit: { max: 2, windowMs: 60_000 } });
    expect((await fetch(url('/api/config'))).status).toBe(200);
    expect((await fetch(url('/api/config'))).status).toBe(200);
    const limited = await fetch(url('/api/config'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get('cache-control')).toBe('no-store');
    expect(await limited.json()).toEqual({ error: 'too many requests, slow down' });
  });

  it('is read-only: writes are refused', async () => {
    const { url } = await start('/admin/events');
    const response = await fetch(url('/api/topics'), { method: 'POST' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'the board is read-only' });
  });

  describe('writes', () => {
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-eventlane-board': '1', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    it('needs readOnly: false, the CSRF header and a JSON body', async () => {
      const { url, bus } = await start('/admin/events', { readOnly: false });
      await raw.xadd(
        `${prefix}:users:dlq`,
        '*',
        'event',
        'user.created',
        'payload',
        '{}',
        'headers',
        '{}',
        'consumer',
        'workers',
        'attempt',
        '3',
        'error',
        'boom',
        'stack',
        '',
        'originalId',
        '1-1',
        'failedAt',
        '1',
      );
      const endpoint = url('/api/topics/users/dlq/retry');

      const withoutHeader = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      expect(withoutHeader.status).toBe(403);

      const foreign = await post(endpoint, { all: true }, { origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);

      const invalid = await post(endpoint, '{not json');
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'invalid JSON body' });

      const ok = await post(endpoint, { all: true });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ retried: 1 });
      expect(await bus.dlq.count('users')).toBe(0);
    });

    it('deletes with a typed confirmation in the query', async () => {
      const { url, bus } = await start('/admin/events', { readOnly: false });
      await bus.emit('users', 'user.created');
      const headers = { 'x-eventlane-board': '1' };
      expect((await fetch(url('/api/topics/users'), { method: 'DELETE', headers })).status).toBe(
        400,
      );
      const response = await fetch(url('/api/topics/users?confirm=users'), {
        method: 'DELETE',
        headers,
      });
      expect(response.status).toBe(200);
      expect(await bus.topics()).toEqual([]);
    });
  });

  it('hands the Express request to authorize', async () => {
    const { url } = await start('/admin/events', {
      authorize: (request) => (request as express.Request).headers['x-token'] === 'secret',
    });
    expect((await fetch(url('/api/topics'))).status).toBe(403);
    expect((await fetch(url('/api/topics'), { headers: { 'x-token': 'secret' } })).status).toBe(
      200,
    );
  });

  it('applies redaction before anything leaves the server', async () => {
    const { url, bus } = await start('/admin/events', {
      redact: (event) => ({ ...event, payload: { ...(event.payload as object), email: '***' } }),
    });
    await bus.emit('users', 'user.created', { id: 1, email: 'a@b.com' });
    const events = (await (await fetch(url('/api/topics/users/events'))).json()) as Json;
    expect(events.events[0].preview).toBe('{"id":1,"email":"***"}');
  });
});
