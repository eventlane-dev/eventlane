import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { EventLaneError, type EventMetadata } from '../src';
import { REDIS_URL, sleep, useBuses, waitFor } from './helpers';

const { prefix, raw, createBus, pendingCount } = useBuses();
const url = new URL(REDIS_URL);

describe('configuration', () => {
  it('requires exactly one of redisUrl and redis', () => {
    expect(() => createBus({ redisUrl: undefined, redis: undefined } as never)).toThrow(
      EventLaneError,
    );
    expect(() => createBus({ redisUrl: REDIS_URL, redis: { host: 'localhost' } } as never)).toThrow(
      /exactly one/,
    );
  });

  it('accepts a connection object', async () => {
    const bus = createBus({
      redisUrl: undefined,
      redis: { host: url.hostname, port: Number(url.port || 6379) },
    } as never);
    const id = await bus.emit('users', 'user.created', { id: 1 });
    expect(id).toMatch(/^\d+-\d+$/);
  });

  it('rejects invalid names', async () => {
    const bus = createBus({ consumerName: 'notifications' });
    await expect(bus.emit('bad:topic', 'x')).rejects.toThrow(/topicName/);
    expect(() => bus.on('users', () => {}, { consumerName: 'bad name' })).toThrow(/consumerName/);
    expect(() => createBus({ instanceName: 'a:b' })).toThrow(/instanceName/);
  });

  it('requires a consumerName to listen', () => {
    const bus = createBus();
    expect(() => bus.on('users', () => {})).toThrow(/consumerName is required/);
  });

  it('does not close an ioredis client it did not create', async () => {
    const client = new Redis(REDIS_URL);
    const bus = createBus({ redisUrl: undefined, redis: client } as never);
    await bus.emit('users', 'user.created');
    await bus.close();
    expect(client.status).toBe('ready');
    await expect(client.ping()).resolves.toBe('PONG');
    await client.quit();
  });
});

describe('emit', () => {
  it('stores the event in events:<topicName> style keys with its fields', async () => {
    const bus = createBus();
    const id = await bus.emit(
      'users',
      'user.created',
      { id: 1 },
      { headers: { correlationId: 'abc' } },
    );
    const entries = await raw.xrange(`${prefix}:users`, '-', '+');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toBe(id);
    const fields = entries[0]?.[1] ?? [];
    expect(fields).toEqual([
      'event',
      'user.created',
      'payload',
      '{"id":1}',
      'attempt',
      '1',
      'headers',
      '{"correlationId":"abc"}',
    ]);
  });

  it('uses the default prefix "events"', async () => {
    const bus = createBus({ prefix: undefined });
    const unique = `topic-${Date.now()}`;
    await bus.emit(unique, 'x');
    expect(await raw.exists(`events:${unique}`)).toBe(1);
    await raw.del(`events:${unique}`);
  });

  it('works on a bus that was never started and rejects after close', async () => {
    const bus = createBus();
    await bus.emit('users', 'user.created');
    await bus.close();
    await expect(bus.emit('users', 'user.created')).rejects.toThrow(/closed/);
  });
});

describe('listening', () => {
  it('delivers payload and metadata, then acknowledges', async () => {
    const bus = createBus({ consumerName: 'notifications', instanceName: 'inst-1' });
    const received: Array<{ payload: unknown; meta: EventMetadata }> = [];
    bus.on('users', 'user.created', (payload, meta) => {
      received.push({ payload, meta });
    });
    await bus.start();

    const id = await bus.emit('users', 'user.created', { id: 7 }, { headers: { k: 'v' } });
    await waitFor(() => received.length === 1);

    const { payload, meta } = received[0] as (typeof received)[number];
    expect(payload).toEqual({ id: 7 });
    expect(meta).toMatchObject({
      id,
      topicName: 'users',
      eventName: 'user.created',
      consumerName: 'notifications',
      instanceName: 'inst-1',
      streamKey: `${prefix}:users`,
      attempt: 1,
      headers: { k: 'v' },
    });
    expect(meta.timestamp).toBe(Number(id.split('-')[0]));
    await waitFor(async () => (await pendingCount('users', 'notifications')) === 0);
  });

  it('filters by eventName and acknowledges events nobody handles', async () => {
    const bus = createBus({ consumerName: 'notifications' });
    const created: unknown[] = [];
    bus.on('users', 'user.created', (payload) => {
      created.push(payload);
    });
    await bus.start();

    await bus.emit('users', 'user.deleted', { id: 1 });
    await bus.emit('users', 'user.created', { id: 2 });
    await waitFor(() => created.length === 1);
    expect(created).toEqual([{ id: 2 }]);
    await waitFor(async () => (await pendingCount('users', 'notifications')) === 0);
  });

  it('a topic-wide handler receives every event of the topic', async () => {
    const bus = createBus({ consumerName: 'audit' });
    const names: string[] = [];
    bus.on('users', (_payload, meta) => {
      names.push(meta.eventName);
    });
    await bus.start();
    await bus.emit('users', 'user.created');
    await bus.emit('users', 'user.updated');
    await waitFor(() => names.length === 2);
    expect(names).toEqual(['user.created', 'user.updated']);
  });

  it('listens to several topics with one handler and through a TopicEmitter', async () => {
    const bus = createBus({ consumerName: 'audit' });
    const seen: string[] = [];
    bus.on(['users', 'orders'], (_payload, meta) => {
      seen.push(`${meta.topicName}:${meta.eventName}`);
    });
    await bus.start();
    await bus.emitter('users').emit('user.created');
    await bus.emit('orders', 'order.placed');
    await waitFor(() => seen.length === 2);
    expect(seen.sort()).toEqual(['orders:order.placed', 'users:user.created']);
  });

  it('TopicEmitter.on binds the topic', async () => {
    const bus = createBus({ consumerName: 'audit' });
    const users = bus.emitter('users');
    const seen: unknown[] = [];
    users.on('user.created', (payload) => {
      seen.push(payload);
    });
    await bus.start();
    await users.emit('user.created', 1);
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([1]);
  });

  it('fans out: every consumer receives its own copy', async () => {
    const notifications = createBus({ consumerName: 'notifications' });
    const webhooks = createBus({ consumerName: 'webhooks' });
    const a: unknown[] = [];
    const b: unknown[] = [];
    notifications.on('users', 'user.created', (p) => void a.push(p));
    webhooks.on('users', 'user.created', (p) => void b.push(p));
    await Promise.all([notifications.start(), webhooks.start()]);

    await notifications.emit('users', 'user.created', { id: 1 });
    await waitFor(() => a.length === 1 && b.length === 1);
    expect(a).toEqual([{ id: 1 }]);
    expect(b).toEqual([{ id: 1 }]);
  });

  it('load balances: instances of one consumer share the events, each handled once', async () => {
    const make = (instanceName: string, sink: number[]) => {
      const bus = createBus({ consumerName: 'notifications', instanceName });
      bus.on('users', 'user.created', async (payload: { n: number }) => {
        await sleep(15);
        sink.push(payload.n);
      });
      return bus;
    };
    const first: number[] = [];
    const second: number[] = [];
    const a = make('inst-a', first);
    const b = make('inst-b', second);
    await Promise.all([a.start(), b.start()]);

    const total = 30;
    for (let n = 0; n < total; n++) await a.emit('users', 'user.created', { n });
    await waitFor(() => first.length + second.length === total, 8000);

    expect([...first, ...second].sort((x, y) => x - y)).toEqual([...Array(total).keys()]);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });

  it('startFrom "$" skips history, "0" replays it for a new consumer', async () => {
    const bus = createBus();
    await bus.emit('users', 'user.created', { n: 1 });

    const fresh: unknown[] = [];
    const full: unknown[] = [];
    bus.on('users', (p) => void fresh.push(p), { consumerName: 'new-only' });
    bus.on('users', (p) => void full.push(p), { consumerName: 'history', startFrom: '0' });
    await bus.start();
    await bus.emit('users', 'user.created', { n: 2 });

    await waitFor(() => full.length === 2 && fresh.length === 1);
    expect(fresh).toEqual([{ n: 2 }]);
    expect(full).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('subscriptions added after start begin immediately and can be removed', async () => {
    const bus = createBus({ consumerName: 'late' });
    await bus.start();
    const seen: unknown[] = [];
    const off = bus.on('users', (p) => void seen.push(p));

    await sleep(50);
    await bus.emit('users', 'user.created', 1);
    await waitFor(() => seen.length === 1);

    off();
    await sleep(300);
    await bus.emit('users', 'user.created', 2);
    await sleep(400);
    expect(seen).toEqual([1]);
  });
});

describe('concurrency and ordering', () => {
  it('concurrency 1 handles events one at a time, in order', async () => {
    const bus = createBus({ consumerName: 'ordered' });
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    bus.on('users', async (payload: { n: number }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(10);
      order.push(payload.n);
      active--;
    });
    await bus.start();
    for (let n = 0; n < 10; n++) await bus.emit('users', 'user.created', { n });
    await waitFor(() => order.length === 10);
    expect(order).toEqual([...Array(10).keys()]);
    expect(maxActive).toBe(1);
  });

  it('concurrency N runs up to N handlers in parallel', async () => {
    const bus = createBus({ consumerName: 'parallel' });
    let active = 0;
    let maxActive = 0;
    let done = 0;
    bus.on(
      'users',
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(50);
        active--;
        done++;
      },
      { concurrency: 3 },
    );
    await bus.start();
    for (let n = 0; n < 9; n++) await bus.emit('users', 'user.created', { n });
    await waitFor(() => done === 9);
    expect(maxActive).toBe(3);
  });
});

describe('close', () => {
  it('waits for in-flight handlers, then leaves the consumer', async () => {
    const bus = createBus({ consumerName: 'slow', instanceName: 'inst-1' });
    let finished = false;
    let started = false;
    bus.on('users', async () => {
      started = true;
      await sleep(300);
      finished = true;
    });
    await bus.start();
    await bus.emit('users', 'user.created');
    await waitFor(() => started);

    const t0 = Date.now();
    await bus.close();
    expect(finished).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1500);

    // handled and acknowledged, so the instance was removed from the consumer
    expect(await pendingCount('users', 'slow')).toBe(0);
    const consumers = (await raw.call(
      'XINFO',
      'CONSUMERS',
      `${prefix}:users`,
      'slow',
    )) as unknown[];
    expect(consumers).toHaveLength(0);
  });

  it('stops promptly even while blocked waiting for events', async () => {
    const bus = createBus({ consumerName: 'idle', blockTimeMs: 5000 });
    bus.on('users', () => {});
    await bus.start();
    await sleep(100);
    const t0 = Date.now();
    await bus.close();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('times out on a stuck handler and keeps its event pending', async () => {
    const bus = createBus({ consumerName: 'stuck', shutdownTimeoutMs: 200 });
    let started = false;
    bus.on('users', async () => {
      started = true;
      await sleep(2000);
    });
    await bus.start();
    await bus.emit('users', 'user.created');
    await waitFor(() => started);
    await bus.close();
    expect(await pendingCount('users', 'stuck')).toBe(1);
  });

  it('is idempotent', async () => {
    const bus = createBus({ consumerName: 'x' });
    bus.on('users', () => {});
    await bus.start();
    await bus.close();
    await bus.close();
  });
});

describe('overlapping handlers', () => {
  const recording = () => {
    const warnings: string[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => warnings.push(message),
      error: () => undefined,
    };
    return { warnings, logger };
  };

  it('warns when two handlers of one consumer match the same event', () => {
    const { warnings, logger } = recording();
    const bus = createBus({ consumerName: 'notifications', logger });
    bus.on('users', 'user.created', () => undefined);
    expect(warnings).toHaveLength(0);
    bus.on('users', 'user.created', () => undefined);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/notifications.*user\.created.*users/);
    bus.on('users', () => undefined); // matches every event, so it overlaps too
    expect(warnings).toHaveLength(2);
  });

  it('stays quiet for different events and for different consumers', () => {
    const { warnings, logger } = recording();
    const bus = createBus({ consumerName: 'notifications', logger });
    bus.on('users', 'user.created', () => undefined);
    bus.on('users', 'user.deleted', () => undefined);
    bus.on('users', 'user.created', () => undefined, { consumerName: 'webhooks' } as never);
    expect(warnings).toHaveLength(0);
  });
});
