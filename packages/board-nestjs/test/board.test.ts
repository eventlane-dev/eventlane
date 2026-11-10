import { randomBytes } from 'node:crypto';
import { EventLaneEmitter, EventLaneModule } from '@eventlane/nestjs';
import type { INestApplication } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { BoardModule, type BoardModuleOptions } from '../src';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6390';
const prefix = `n-${randomBytes(4).toString('hex')}`;
const raw = new Redis(REDIS_URL);
const apps: INestApplication[] = [];

// biome-ignore lint/suspicious/noExplicitAny: test helper over loosely typed JSON responses
type Json = Record<string, any>;

const eventLane = () => EventLaneModule.forRoot({ redisUrl: REDIS_URL, prefix, blockTimeMs: 200 });

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => {})));
  const keys = await raw.keys(`${prefix}*`);
  if (keys.length > 0) await raw.del(...keys);
});
afterAll(async () => {
  await raw.quit();
});

async function start(platform: 'express' | 'fastify', board: DynamicModuleLike) {
  const moduleRef = await Test.createTestingModule({ imports: [eventLane(), board] }).compile();
  const app =
    platform === 'fastify'
      ? moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
      : moduleRef.createNestApplication();
  apps.push(app);
  await app.init();
  if (platform === 'fastify')
    await (app as NestFastifyApplication).getHttpAdapter().getInstance().ready();
  await app.listen(0, '127.0.0.1');
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, url, emitter: app.get(EventLaneEmitter) };
}
type DynamicModuleLike = ReturnType<typeof BoardModule.forRoot>;

for (const platform of ['express', 'fastify'] as const) {
  describe(`on ${platform}`, () => {
    it('serves the page and the API at the default route, showing the EventLaneModule bus', async () => {
      const { url, emitter } = await start(platform, BoardModule.forRoot());
      await emitter.emit('users', 'user.created', { id: 1 });

      const page = await fetch(`${url}/admin/events/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<base href="/admin/events/">');
      expect(html).toContain('EventLane board');

      const config = (await (await fetch(`${url}/admin/events/api/config`)).json()) as Json;
      expect(config).toEqual({ readOnly: true, hidePayloads: false, buses: ['default'] });
      const topics = (await (await fetch(`${url}/admin/events/api/topics`)).json()) as Json;
      expect(topics.topics).toEqual([expect.objectContaining({ topicName: 'users', length: 1 })]);
    });

    it('serves at a custom route and applies the board options', async () => {
      const { url, emitter } = await start(
        platform,
        BoardModule.forRoot({
          route: 'board/',
          readOnly: false,
          redact: (event) => ({ ...event, payload: '***' }),
        }),
      );
      await emitter.emit('users', 'user.created', { secret: 1 });

      expect((await fetch(`${url}/admin/events/`)).status).toBe(404);
      expect((await fetch(`${url}/board/`)).status).toBe(200);
      expect(((await (await fetch(`${url}/board/api/config`)).json()) as Json).readOnly).toBe(
        false,
      );
      const events = (await (await fetch(`${url}/board/api/topics/users/events`)).json()) as Json;
      expect(events.events[0].preview).toBe('"***"');
    });

    it('builds its options asynchronously', async () => {
      @Module({ providers: [{ provide: 'ROUTE', useValue: '/ops/events' }], exports: ['ROUTE'] })
      class SettingsModule {}

      const { url } = await start(
        platform,
        BoardModule.forRootAsync({
          imports: [SettingsModule],
          inject: ['ROUTE'],
          useFactory: (route: string): BoardModuleOptions => ({ route, hidePayloads: true }),
        }),
      );
      const config = (await (await fetch(`${url}/ops/events/api/config`)).json()) as Json;
      expect(config).toMatchObject({ hidePayloads: true });
    });

    it('can authorize requests', async () => {
      const { url } = await start(
        platform,
        BoardModule.forRoot({
          authorize: (request) =>
            (request as { headers: Record<string, string> }).headers['x-token'] === 'secret',
        }),
      );
      expect((await fetch(`${url}/admin/events/api/topics`)).status).toBe(403);
      const ok = await fetch(`${url}/admin/events/api/topics`, {
        headers: { 'x-token': 'secret' },
      });
      expect(ok.status).toBe(200);
    });
  });
}

describe('express middleware', () => {
  it('runs before the board', async () => {
    const { url } = await start(
      'express',
      BoardModule.forRoot({
        middleware: [
          (req, res, next) => {
            if (req.headers['x-admin'] === '1') return next();
            res.status(401).json({ error: 'sign in' });
          },
        ],
      }),
    );
    expect((await fetch(`${url}/admin/events/`)).status).toBe(401);
    expect((await fetch(`${url}/admin/events/`, { headers: { 'x-admin': '1' } })).status).toBe(200);
  });
});

describe('misconfiguration', () => {
  it('needs a bus', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BoardModule.forRoot()],
    }).compile();
    const app = moduleRef.createNestApplication();
    apps.push(app);
    await expect(app.init()).rejects.toThrow(/needs a bus/);
  });

  it('needs an HTTP application', async () => {
    @Module({ imports: [eventLane(), BoardModule.forRoot()] })
    class AppModule {}
    const context = await NestFactory.createApplicationContext(AppModule, { logger: false }).catch(
      (error) => error as Error,
    );
    expect(String(context)).toMatch(/needs an HTTP application/);
  });
});
