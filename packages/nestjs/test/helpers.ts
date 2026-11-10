import { randomBytes } from 'node:crypto';
import type { ModuleMetadata } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, afterEach } from 'vitest';
import type { EventLaneModuleOptions } from '../src';

export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6390';
// REDIS_PROTOCOL=2 runs the whole suite on RESP2 (ioredis 6 defaults to RESP3)
const PROTOCOL = process.env.REDIS_PROTOCOL === '2' ? 2 : undefined;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  message = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await sleep(10);
  }
}

/**
 * An isolated key prefix, fast timings, and a factory for Nest test applications that are all
 * closed (and whose Redis keys are removed) after each test.
 */
export function useNestApps() {
  const prefix = `n-${randomBytes(4).toString('hex')}`;
  const apps: TestingModule[] = [];
  const raw = new Redis(REDIS_URL, PROTOCOL === undefined ? {} : { protocol: PROTOCOL });

  const rootOptions = (extra: Record<string, unknown> = {}): EventLaneModuleOptions => {
    const url = new URL(REDIS_URL);
    const connection =
      PROTOCOL === undefined
        ? { redisUrl: REDIS_URL }
        : { redis: { host: url.hostname, port: Number(url.port || 6379), protocol: PROTOCOL } };
    return {
      ...connection,
      prefix,
      blockTimeMs: 200,
      retry: { attempts: 5, backoff: { type: 'fixed', delay: 50 } },
      retryPollMs: 20,
      claimIntervalMs: 100,
      claimIdleMs: 1000,
      shutdownTimeoutMs: 2000,
      ...extra,
    } as EventLaneModuleOptions;
  };

  const createApp = async (metadata: ModuleMetadata): Promise<TestingModule> => {
    const app = await Test.createTestingModule(metadata).compile();
    apps.push(app);
    await app.init();
    return app;
  };

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close().catch(() => {})));
    const keys = await raw.keys(`${prefix}:*`);
    if (keys.length > 0) await raw.del(...keys);
  });

  afterAll(async () => {
    await raw.quit();
  });

  return { prefix, raw, rootOptions, createApp };
}
