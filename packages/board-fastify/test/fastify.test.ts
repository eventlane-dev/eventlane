import { randomBytes } from 'node:crypto';
import { EventLaneBus } from '@eventlane/core';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type BoardOptions, createBoard } from '../src';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6390';
const prefix = `f-${randomBytes(4).toString('hex')}`;
const raw = new Redis(REDIS_URL);
const closers: Array<() => Promise<void>> = [];

// biome-ignore lint/suspicious/noExplicitAny: test helper over loosely typed JSON responses
type Json = Record<string, any>;

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  const keys = await raw.keys(`${prefix}*`);
  if (keys.length > 0) await raw.del(...keys);
});
afterAll(async () => {
  await raw.quit();
});

async function start(mountAt: string, options: Partial<BoardOptions> = {}) {
  const bus = new EventLaneBus({ redisUrl: REDIS_URL, prefix });
  const app: FastifyInstance = Fastify();
  await app.register(createBoard({ buses: bus, ...options }).plugin, { prefix: mountAt });
  await app.ready();
  closers.push(async () => {
    await app.close();
    await bus.close();
  });
  return { app, bus };
}

describe('serving the UI', () => {
  it('serves the page under the prefix with a matching <base>, and its assets', async () => {
    const { app } = await start('/admin/events');
    for (const url of ['/admin/events', '/admin/events/']) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.body).toContain('<base href="/admin/events/">');

      const script = /src="\.\/(assets\/[^"]+\.js)"/.exec(response.body)?.[1];
      const style = /href="\.\/(assets\/[^"]+\.css)"/.exec(response.body)?.[1];
      expect(script).toBeDefined();
      const asset = await app.inject({ url: `/admin/events/${script}` });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');
      expect((await app.inject({ url: `/admin/events/${style}` })).statusCode).toBe(200);
    }
    expect((await app.inject({ url: '/admin/events/nope.txt' })).statusCode).toBe(404);
  });

  it('never serves files outside the UI directory', async () => {
    const { app } = await start('/admin/events');
    for (const url of [
      '/admin/events/../package.json',
      '/admin/events/%2e%2e/package.json',
      '/admin/events/assets/..%2f..%2fpackage.json',
    ]) {
      expect((await app.inject({ url })).statusCode).toBe(404);
    }
  });

  it('works mounted at the root', async () => {
    const { app } = await start('');
    const response = await app.inject({ url: '/' });
    expect(response.body).toContain('<base href="/">');
  });
});

describe('the API', () => {
  it('serves JSON from the bus under /api and never caches it', async () => {
    const { app, bus } = await start('/admin/events');
    await bus.emit('users', 'user.created', { id: 1 });

    const config = await app.inject({ url: '/admin/events/api/config' });
    expect(config.headers['cache-control']).toBe('no-store');
    expect(config.json()).toEqual({ readOnly: true, hidePayloads: false, buses: ['default'] });

    const topics = (await app.inject({ url: '/admin/events/api/topics' })).json() as Json;
    expect(topics.topics).toEqual([expect.objectContaining({ topicName: 'users', length: 1 })]);
    const events = (
      await app.inject({ url: '/admin/events/api/topics/users/events?limit=5' })
    ).json() as Json;
    expect(events.events[0]).toMatchObject({ eventName: 'user.created', preview: '{"id":1}' });

    const bad = await app.inject({ url: '/admin/events/api/topics/users/events?limit=0' });
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ url: '/admin/events/api/nothing' })).statusCode).toBe(404);
  });

  it('rate limits per client and says when to come back', async () => {
    const { app } = await start('/admin/events', { rateLimit: { max: 2, windowMs: 60_000 } });
    expect((await app.inject({ url: '/admin/events/api/config' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/admin/events/api/config' })).statusCode).toBe(200);
    const limited = await app.inject({ url: '/admin/events/api/config' });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited.json()).toEqual({ error: 'too many requests, slow down' });
  });

  it('is read-only by default and hands the Fastify request to authorize', async () => {
    const { app } = await start('/admin/events', {
      authorize: (request) =>
        (request as { headers: Record<string, string> }).headers['x-token'] === 'secret',
    });
    expect((await app.inject({ url: '/admin/events/api/topics' })).statusCode).toBe(403);
    expect(
      (await app.inject({ url: '/admin/events/api/topics', headers: { 'x-token': 'secret' } }))
        .statusCode,
    ).toBe(200);
    const write = await app.inject({
      method: 'POST',
      url: '/admin/events/api/topics',
      headers: { 'x-token': 'secret' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json()).toEqual({ error: 'the board is read-only' });
  });

  describe('writes', () => {
    const headers = { 'x-eventlane-board': '1', 'content-type': 'application/json' };

    it('need readOnly: false, the CSRF header and a JSON body', async () => {
      const { app, bus } = await start('/admin/events', { readOnly: false });
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
      const url = '/admin/events/api/topics/users/dlq/retry';

      const noHeader = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: { all: true },
      });
      expect(noHeader.statusCode).toBe(403);
      const foreign = await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, origin: 'https://evil.example' },
        payload: { all: true },
      });
      expect(foreign.statusCode).toBe(403);
      const invalid = await app.inject({ method: 'POST', url, headers, payload: '{not json' });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({ error: 'invalid JSON body' });

      const ok = await app.inject({ method: 'POST', url, headers, payload: { all: true } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ retried: 1 });
      expect(await bus.dlq.count('users')).toBe(0);
    });

    it('delete with a typed confirmation in the query', async () => {
      const { app, bus } = await start('/admin/events', { readOnly: false });
      await bus.emit('users', 'user.created');
      const h = { 'x-eventlane-board': '1' };
      expect(
        (await app.inject({ method: 'DELETE', url: '/admin/events/api/topics/users', headers: h }))
          .statusCode,
      ).toBe(400);
      const response = await app.inject({
        method: 'DELETE',
        url: '/admin/events/api/topics/users?confirm=users',
        headers: h,
      });
      expect(response.statusCode).toBe(200);
      expect(await bus.topics()).toEqual([]);
    });
  });
});
