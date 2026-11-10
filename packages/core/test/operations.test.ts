import { describe, expect, it } from 'vitest';
import { EventLaneError } from '../src';
import { replayStartId } from '../src/ids';
import { resolveRetention, trimArguments } from '../src/operations';
import { sleep, useBuses, waitFor } from './helpers';

const { prefix, raw, createBus, pendingCount } = useBuses();

const entry = (id: string, eventName = 'e', payload = '1') =>
  raw.xadd(
    `${prefix}:users`,
    id,
    'event',
    eventName,
    'payload',
    payload,
    'attempt',
    '1',
    'headers',
    '{}',
  );

describe('retention', () => {
  it('trims to about maxLen on emit', async () => {
    const bus = createBus({ topics: { users: { retention: { maxLen: 100 } } } });
    for (let n = 0; n < 400; n++) await bus.emit('users', 'user.created', { n });
    const length = await raw.xlen(`${prefix}:users`);
    // approximate trimming works on whole blocks, so it keeps somewhat more than the limit
    expect(length).toBeGreaterThanOrEqual(100);
    expect(length).toBeLessThan(250);
    const [newest] = await bus.read('users', { count: 1, reverse: true });
    expect(newest?.payload).toEqual({ n: 399 });
  });

  it('trims events older than maxAgeMs on emit', async () => {
    const old = Date.now() - 10 * 24 * 3600_000;
    for (let n = 0; n < 350; n++) await entry(`${old + n}-0`);
    const bus = createBus({ topics: { users: { retention: { maxAgeMs: 3600_000 } } } });
    await bus.emit('users', 'user.created');
    const length = await raw.xlen(`${prefix}:users`);
    expect(length).toBeLessThan(351);
    const [oldest] = await bus.read('users', { count: 1 });
    expect(Number(oldest?.id.split('-')[0])).toBeGreaterThan(old);
  });

  it('applies both limits and also on idempotent emits', async () => {
    const bus = createBus({
      topics: { users: { retention: { maxLen: 100, maxAgeMs: 3600_000 } } },
    });
    for (let n = 0; n < 400; n++) {
      await bus.emit('users', 'user.created', { n }, { idempotencyKey: `k-${n}` });
    }
    expect(await raw.xlen(`${prefix}:users`)).toBeLessThan(250);
  });

  it('applies the bus default to topics without their own setting', async () => {
    const bus = createBus({
      retention: { maxLen: 100 },
      topics: { orders: { retention: false } },
    });
    for (let n = 0; n < 400; n++) {
      await bus.emit('users', 'user.created', { n });
      await bus.emit('orders', 'order.created', { n });
    }
    expect(await raw.xlen(`${prefix}:users`)).toBeLessThan(250);
    expect(await raw.xlen(`${prefix}:orders`)).toBe(400);
  });

  it('trims by 1 000 000 events by default and keeps everything with false', () => {
    expect(resolveRetention(undefined, undefined)).toEqual({ maxLen: 1_000_000 });
    expect(resolveRetention({ retention: false }, { maxLen: 5 })).toBe(false);
    expect(resolveRetention({}, false)).toBe(false);
    expect(trimArguments(false, 0)).toEqual({ inline: [], after: undefined });
  });

  it('does not touch other topics and validates the settings', async () => {
    const bus = createBus({ topics: { orders: { retention: { maxLen: 100 } } } });
    for (let n = 0; n < 250; n++) await bus.emit('users', 'user.created', { n });
    expect(await raw.xlen(`${prefix}:users`)).toBe(250);
    expect(() => createBus({ retention: { maxLen: 0 } })).toThrow(EventLaneError);
    expect(() => createBus({ topics: { users: { retention: { maxLen: 0 } } } })).toThrow(
      EventLaneError,
    );
    expect(() => createBus({ topics: { 'bad:name': {} } })).toThrow(/topicName/);
  });
});

describe('read', () => {
  it('returns stored events, oldest first, without affecting consumers', async () => {
    const bus = createBus();
    await bus.emit('users', 'user.created', { n: 1 }, { headers: { h: 'x' } });
    await bus.emit('users', 'user.updated', { n: 2 });
    const events = await bus.read('users');
    expect(events.map((e) => e.eventName)).toEqual(['user.created', 'user.updated']);
    expect(events[0]).toMatchObject({
      topicName: 'users',
      payload: { n: 1 },
      headers: { h: 'x' },
    });
    expect(events[0]?.timestamp).toBe(Number(events[0]?.id.split('-')[0]));
    expect(await raw.call('XINFO', 'GROUPS', `${prefix}:users`).catch(() => [])).toEqual([]);
  });

  it('supports count, reverse and ranges by id, timestamp and Date', async () => {
    const base = Date.now() - 100_000;
    for (let n = 0; n < 5; n++) await entry(`${base + n * 1000}-0`, 'e', String(n));
    const bus = createBus();

    expect((await bus.read('users', { count: 2 })).map((e) => e.payload)).toEqual([0, 1]);
    expect((await bus.read('users', { count: 2, reverse: true })).map((e) => e.payload)).toEqual([
      4, 3,
    ]);
    expect((await bus.read('users', { from: `${base + 2000}-0` })).map((e) => e.payload)).toEqual([
      2, 3, 4,
    ]);
    expect(
      (await bus.read('users', { from: base + 1000, to: base + 3000 })).map((e) => e.payload),
    ).toEqual([1, 2, 3]);
    expect(
      (await bus.read('users', { from: new Date(base + 3000), reverse: true })).map(
        (e) => e.payload,
      ),
    ).toEqual([4, 3]);
    expect(await bus.read('orders')).toEqual([]);
  });

  it('returns the raw text for a payload that is not JSON and rejects bad arguments', async () => {
    await raw.xadd(`${prefix}:users`, '*', 'event', 'e', 'payload', 'not json');
    const bus = createBus();
    expect((await bus.read('users'))[0]?.payload).toBe('not json');
    await expect(bus.read('users', { count: 0 })).rejects.toThrow(/count/);
    await expect(bus.read('users', { from: 'nope' })).rejects.toThrow(/position/);
    await expect(bus.read('bad:topic')).rejects.toThrow(/topicName/);
  });
});

describe('replay', () => {
  it('replayStartId is the id just before the requested position', () => {
    expect(replayStartId('0')).toBe('0-0');
    expect(replayStartId('$')).toBe('$');
    expect(replayStartId('5-3')).toBe('5-2');
    expect(replayStartId('5-0')).toBe('4-18446744073709551615');
    expect(replayStartId(5)).toBe('4-18446744073709551615');
    expect(replayStartId(new Date(7))).toBe('6-18446744073709551615');
    expect(replayStartId('0-0')).toBe('0-0');
    expect(() => replayStartId('nope')).toThrow(/replay position/);
  });

  it('re-delivers history to a running consumer when moved back', async () => {
    const bus = createBus({ consumerName: 'reporting' });
    const seen: number[] = [];
    bus.on('users', (p: { n: number }) => void seen.push(p.n));
    await bus.start();
    for (let n = 1; n <= 3; n++) await bus.emit('users', 'user.created', { n });
    await waitFor(() => seen.length === 3);

    await bus.replay('users', { from: '0' });
    await waitFor(() => seen.length === 6);
    expect(seen).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('starts at the given event id (inclusive)', async () => {
    const bus = createBus({ consumerName: 'reporting' });
    const ids: string[] = [];
    for (let n = 1; n <= 4; n++) ids.push(await bus.emit('users', 'user.created', { n }));
    const seen: number[] = [];
    bus.on('users', (p: { n: number }) => void seen.push(p.n));
    await bus.start();

    await bus.replay('users', { from: ids[2] as string });
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([3, 4]);
  });

  it('starts at a timestamp (ms or Date): the first event at or after it', async () => {
    const base = Date.now() - 100_000;
    for (let n = 1; n <= 4; n++) await entry(`${base + n * 1000}-0`, 'e', String(n));
    const bus = createBus({ consumerName: 'reporting' });
    const seen: number[] = [];
    bus.on('users', (p: number) => void seen.push(p), { startFrom: '$' });
    await bus.start();

    await bus.replay('users', { from: base + 2000 }); // exactly event 2
    await waitFor(() => seen.length === 3);
    expect(seen).toEqual([2, 3, 4]);

    seen.length = 0;
    await bus.replay('users', { from: new Date(base + 2500) }); // between 2 and 3
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([3, 4]);
  });

  it('"$" skips everything stored so far', async () => {
    const bus = createBus({ consumerName: 'reporting' });
    const seen: number[] = [];
    bus.on('users', (p: { n: number }) => void seen.push(p.n), { startFrom: '0' });
    await bus.emit('users', 'user.created', { n: 1 });
    await bus.start();
    await waitFor(() => seen.length === 1);

    await bus.replay('users', { from: '$' });
    await bus.emit('users', 'user.created', { n: 2 });
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([1, 2]);
  });

  it('creates the topic too when replaying a consumer of a topic that does not exist yet', async () => {
    const bus = createBus();
    await bus.replay('brand-new', { consumerName: 'reporting', from: '$' });
    expect(await bus.topics()).toEqual(['brand-new']);
    expect((await bus.stats('brand-new')).consumers.map((c) => c.consumerName)).toEqual([
      'reporting',
    ]);
  });

  it('creates a consumer that does not exist yet, and needs a consumerName', async () => {
    const bus = createBus();
    await bus.emit('users', 'user.created', { n: 1 });
    await expect(bus.replay('users', { from: '0' })).rejects.toThrow(/consumerName is required/);
    await bus.replay('users', { consumerName: 'fresh', from: '0' });

    const seen: unknown[] = [];
    bus.on('users', (p) => void seen.push(p), { consumerName: 'fresh' });
    await bus.start();
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([{ n: 1 }]);
  });
});

describe('stats', () => {
  it('reports size, instances, pending, lag, retries and dead letters per consumer', async () => {
    const a = createBus({ consumerName: 'workers', instanceName: 'inst-a' });
    const b = createBus({ consumerName: 'workers', instanceName: 'inst-b' });
    const failing = createBus({
      consumerName: 'failing',
      retry: { attempts: 5, backoff: { type: 'fixed', delay: 60_000 } },
    });
    for (const bus of [a, b]) bus.on('users', () => {});
    failing.on('users', () => {
      throw new Error('boom');
    });
    await Promise.all([a.start(), b.start(), failing.start()]);

    // a consumer that never reads: everything is lag
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'lagging', '$');
    for (let n = 0; n < 5; n++) await a.emit('users', 'user.created', { n });
    await waitFor(
      async () =>
        (await a.stats('users')).consumers.find((c) => c.consumerName === 'failing')?.retrying ===
        5,
    );
    await raw.xadd(`${prefix}:users:dlq`, '*', 'event', 'e', 'consumer', 'x');

    const stats = await a.stats('users');
    const byName = Object.fromEntries(stats.consumers.map((c) => [c.consumerName, c]));
    expect(stats.topicName).toBe('users');
    expect(stats.length).toBe(5);
    expect(stats.deadLetters).toBe(1);
    expect(byName.workers).toMatchObject({ instances: 2, pending: 0, lag: 0, retrying: 0 });
    expect(byName.failing).toMatchObject({ pending: 0, lag: 0, retrying: 5 });
    expect(byName.lagging).toMatchObject({ instances: 0, pending: 0, lag: 5 });
  });

  it('counts pending events and returns zeros for an unknown topic', async () => {
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'workers', '$', 'MKSTREAM');
    const bus = createBus();
    await bus.emit('users', 'user.created');
    await raw.call(
      'XREADGROUP',
      'GROUP',
      'workers',
      'dead',
      'COUNT',
      10,
      'STREAMS',
      `${prefix}:users`,
      '>',
    );
    const stats = await bus.stats('users');
    expect(stats.consumers[0]).toMatchObject({ consumerName: 'workers', pending: 1, lag: 0 });

    expect(await bus.stats('nothing')).toEqual({
      topicName: 'nothing',
      length: 0,
      deadLetters: 0,
      consumers: [],
    });
  });
});

describe('removing things', () => {
  it('removeConsumer deletes the consumer and its retries but keeps the events', async () => {
    const bus = createBus({
      consumerName: 'old',
      retry: { attempts: 5, backoff: { type: 'fixed', delay: 60_000 } },
    });
    bus.on('users', () => {
      throw new Error('x');
    });
    await bus.start();
    await bus.emit('users', 'user.created');
    await waitFor(async () => (await bus.stats('users')).consumers[0]?.retrying === 1);
    await bus.close();

    const other = createBus();
    expect(await other.removeConsumer('users', 'old')).toBe(true);
    expect((await other.stats('users')).consumers).toEqual([]);
    expect(await raw.exists(`${prefix}:users:old:retry`)).toBe(0);
    expect(await raw.xlen(`${prefix}:users`)).toBe(1);
    expect(await other.removeConsumer('users', 'old')).toBe(false);
  });

  it('deleteTopic requires confirm and removes the topic with everything attached', async () => {
    const bus = createBus({ consumerName: 'workers', retry: { attempts: 1 } });
    bus.on('users', () => {
      throw new Error('x');
    });
    await bus.start();
    await bus.emit('users', 'user.created', null, { idempotencyKey: 'k' });
    await waitFor(async () => (await bus.stats('users')).deadLetters === 1);
    await bus.close();

    const other = createBus();
    await expect(other.deleteTopic('users', {} as never)).rejects.toThrow(/confirm/);
    expect(await raw.exists(`${prefix}:users`)).toBe(1);

    await other.deleteTopic('users', { confirm: true });
    expect(await raw.keys(`${prefix}:*`)).toEqual([]);
  });
});

describe('dedup is scoped to the topic', () => {
  it('does not mix up events of different topics that share an id', async () => {
    const id = '5000000000000-0';
    for (const topic of ['users', 'orders']) {
      await raw.xadd(
        `${prefix}:${topic}`,
        id,
        'event',
        'e',
        'payload',
        '1',
        'attempt',
        '1',
        'headers',
        '{}',
      );
    }
    const bus = createBus({ consumerName: 'audit' });
    const seen: string[] = [];
    bus.on(['users', 'orders'], (_p, meta) => void seen.push(meta.topicName), {
      dedup: true,
      startFrom: '0',
    });
    await bus.start();
    await waitFor(() => seen.length === 2);
    expect(seen.sort()).toEqual(['orders', 'users']);
    await waitFor(async () => (await pendingCount('users', 'audit')) === 0);
    await sleep(50);
    expect(seen).toHaveLength(2);
  });
});
