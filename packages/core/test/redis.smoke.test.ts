import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6390';
const PREFIX = `eventlane-test:${process.pid}:${Date.now()}`;

// Guards the assumptions EventLane builds on: Redis 6.2+ with Streams,
// consumer groups and XAUTOCLAIM. Tests run against a real Redis, never mocks.
describe('redis smoke', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
    } catch (error) {
      throw new Error(
        `Cannot reach Redis at ${REDIS_URL}. Start one with "pnpm redis:up" or set REDIS_URL. (${String(error)})`,
      );
    }
  });

  afterAll(async () => {
    if (redis.status === 'ready') {
      const keys = await redis.keys(`${PREFIX}:*`);
      if (keys.length > 0) await redis.del(...keys);
    }
    redis.disconnect();
  });

  it('runs Redis 6.2 or newer', async () => {
    const info = await redis.info('server');
    const version = /redis_version:(\d+)\.(\d+)/.exec(info);
    expect(version).not.toBeNull();
    const [major, minor] = [Number(version?.[1]), Number(version?.[2])];
    expect(major > 6 || (major === 6 && minor >= 2)).toBe(true);
  });

  it('supports streams, consumer groups, ack and XAUTOCLAIM', async () => {
    const key = `${PREFIX}:users`;
    await redis.xgroup('CREATE', key, 'notifications', '$', 'MKSTREAM');
    const id = await redis.xadd(key, '*', 'event', 'user.created', 'payload', '{"id":1}');
    expect(id).toMatch(/^\d+-\d+$/);

    const read = (await redis.xreadgroup(
      'GROUP',
      'notifications',
      'instance-a',
      'COUNT',
      10,
      'STREAMS',
      key,
      '>',
    )) as [string, [string, string[]][]][] | null;
    expect(read?.[0]?.[1]).toHaveLength(1);

    // Claim the unacknowledged entry for another instance
    const claimed = (await redis.xautoclaim(key, 'notifications', 'instance-b', 0, '0-0')) as [
      string,
      unknown[],
    ];
    expect(claimed[1]).toHaveLength(1);

    expect(await redis.xack(key, 'notifications', id as string)).toBe(1);
  });
});
