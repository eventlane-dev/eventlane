import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach } from 'vitest';
import { EventLaneBus, type EventLaneOptions } from '../src';

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
 * Sets up an isolated key prefix, a raw Redis client for assertions and a factory for buses that
 * are all closed (and whose keys are removed) after each test.
 */
export function useBuses() {
  const prefix = `t-${randomBytes(4).toString('hex')}`;
  const buses: EventLaneBus[] = [];
  const raw = new Redis(REDIS_URL, PROTOCOL === undefined ? {} : { protocol: PROTOCOL });

  const createBus = (options: Partial<EventLaneOptions> = {}): EventLaneBus => {
    const url = new URL(REDIS_URL);
    const connection =
      PROTOCOL === undefined
        ? { redisUrl: REDIS_URL }
        : { redis: { host: url.hostname, port: Number(url.port || 6379), protocol: PROTOCOL } };
    const bus = new EventLaneBus({
      ...connection,
      prefix,
      blockTimeMs: 200,
      retry: { attempts: 5, backoff: { type: 'fixed', delay: 50 } },
      retryPollMs: 20,
      claimIntervalMs: 100,
      claimIdleMs: 1000,
      shutdownTimeoutMs: 2000,
      ...options,
    } as EventLaneOptions);
    buses.push(bus);
    return bus;
  };

  afterEach(async () => {
    await Promise.all(buses.splice(0).map((bus) => bus.close()));
    const keys = await raw.keys(`${prefix}:*`);
    if (keys.length > 0) await raw.del(...keys);
  });

  afterAll(async () => {
    await raw.quit();
  });

  const pendingCount = async (topicName: string, consumerName: string): Promise<number> => {
    const summary = (await raw.call('XPENDING', `${prefix}:${topicName}`, consumerName)) as [
      number,
      ...unknown[],
    ];
    return Number(summary[0]);
  };

  const retryCount = async (topicName: string, consumerName: string): Promise<number> =>
    Number(await raw.zcard(`${prefix}:${topicName}:${consumerName}:retry`));

  const dlqLength = async (topicName: string): Promise<number> =>
    Number(await raw.xlen(`${prefix}:${topicName}:dlq`));

  return { prefix, raw, createBus, pendingCount, retryCount, dlqLength };
}
