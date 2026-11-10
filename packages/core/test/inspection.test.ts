import { describe, expect, it } from 'vitest';
import { EventLaneError } from '../src';
import { compareStreamIds } from '../src/ids';
import { sleep, useBuses, waitFor } from './helpers';

const { prefix, raw, createBus, pendingCount, retryCount, dlqLength } = useBuses();

const event = (id: string, eventName = 'e', payload = '1') =>
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

/** Writes a dead-letter entry the way the core does. */
const deadLetter = (consumer: string, eventName: string, originalId = '1-1', topic = 'users') =>
  raw.xadd(
    `${prefix}:${topic}:dlq`,
    '*',
    'event',
    eventName,
    'payload',
    '{"n":1}',
    'headers',
    '{}',
    'consumer',
    consumer,
    'attempt',
    '3',
    'error',
    'boom',
    'stack',
    '',
    'originalId',
    originalId,
    'failedAt',
    String(Date.now()),
  );

/** Reads as a dead instance would: delivered, never acknowledged. */
const readAs = (topic: string, consumer: string, instance: string) =>
  raw.call(
    'XREADGROUP',
    'GROUP',
    consumer,
    instance,
    'COUNT',
    100,
    'STREAMS',
    `${prefix}:${topic}`,
    '>',
  );

describe('compareStreamIds', () => {
  it('orders ids by time, then sequence', () => {
    expect(compareStreamIds('1-0', '2-0')).toBeLessThan(0);
    expect(compareStreamIds('2-1', '2-0')).toBeGreaterThan(0);
    expect(compareStreamIds('5-5', '5-5')).toBe(0);
    expect(compareStreamIds('10-0', '9-9')).toBeGreaterThan(0);
  });
});

describe('topics()', () => {
  it('lists only topics under the prefix, sorted, without their helper keys', async () => {
    const bus = createBus({ consumerName: 'workers', retry: { attempts: 1 } });
    bus.on('orders', () => {
      throw new Error('x');
    });
    await bus.start();
    await bus.emit('users', 'user.created', null, { idempotencyKey: 'k' });
    await bus.emit('orders', 'order.placed'); // fails: creates a dead-letter stream
    await waitFor(async () => (await dlqLength('orders')) === 1);

    expect(await bus.topics()).toEqual(['orders', 'users']);

    const other = createBus({ prefix: `${prefix}-other` });
    expect(await other.topics()).toEqual([]);
    await other.emit('billing', 'x');
    expect(await other.topics()).toEqual(['billing']);
    await other.deleteTopic('billing', { confirm: true });
  });
});

describe('stats with instances', () => {
  it('lists the instances of each consumer only when asked', async () => {
    const a = createBus({ consumerName: 'workers', instanceName: 'inst-a' });
    const b = createBus({ consumerName: 'workers', instanceName: 'inst-b' });
    for (const bus of [a, b]) bus.on('users', () => {});
    await Promise.all([a.start(), b.start()]);
    await a.emit('users', 'user.created');
    await sleep(100);

    const plain = await a.stats('users');
    expect(plain.consumers[0]?.instanceDetails).toBeUndefined();

    const detailed = await a.stats('users', { instances: true });
    const instances = detailed.consumers[0]?.instanceDetails ?? [];
    expect(instances.map((i) => i.instanceName).sort()).toEqual(['inst-a', 'inst-b']);
    for (const instance of instances) {
      expect(instance.pending).toBe(0);
      expect(instance.idleMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('pending()', () => {
  it('lists events held by instances, with their name, idle time and deliveries', async () => {
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'workers', '$', 'MKSTREAM');
    const bus = createBus();
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) ids.push(await bus.emit('users', name, { name }));
    await readAs('users', 'workers', 'dead-1');
    await sleep(50);

    const all = await bus.pending('users', 'workers');
    expect(all.map((p) => p.id)).toEqual(ids);
    expect(all.map((p) => p.eventName)).toEqual(['a', 'b', 'c']);
    expect(all[0]).toMatchObject({ instanceName: 'dead-1', deliveries: 1 });
    expect(all[0]?.idleMs).toBeGreaterThanOrEqual(40);
    expect(all[0]?.timestamp).toBe(Number(ids[0]?.split('-')[0]));

    expect((await bus.pending('users', 'workers', { count: 2 })).map((p) => p.eventName)).toEqual([
      'a',
      'b',
    ]);
    expect(
      (await bus.pending('users', 'workers', { after: ids[0] as string })).map((p) => p.eventName),
    ).toEqual(['b', 'c']);
    expect(await bus.pending('users', 'workers', { instanceName: 'someone-else' })).toEqual([]);
    expect(await bus.pending('users', 'nobody')).toEqual([]);
    await expect(bus.pending('users', 'workers', { count: 5000 })).rejects.toThrow(/count/);
    await expect(bus.pending('users', 'workers', { after: 'x' })).rejects.toThrow(/after/);
  });

  it('reports an undefined event name for an event trimmed while pending', async () => {
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'workers', '$', 'MKSTREAM');
    const bus = createBus();
    const id = await bus.emit('users', 'user.created');
    await readAs('users', 'workers', 'dead-1');
    await raw.xdel(`${prefix}:users`, id);
    const [entry] = await bus.pending('users', 'workers');
    expect(entry).toMatchObject({ id, eventName: undefined });
  });
});

describe('retries()', () => {
  it('lists events waiting for a retry, soonest first, with paging', async () => {
    const bus = createBus({
      consumerName: 'flaky',
      retry: { attempts: 5, backoff: { type: 'fixed', delay: 60_000 } },
    });
    bus.on('users', () => {
      throw new Error('x');
    });
    await bus.start();
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) ids.push(await bus.emit('users', name));
    await waitFor(async () => (await retryCount('users', 'flaky')) === 3);

    const all = await bus.retries('users', 'flaky');
    expect(all.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(all.map((r) => r.eventName).sort()).toEqual(['a', 'b', 'c']);
    for (const retry of all) {
      expect(retry.attempt).toBe(1);
      expect(retry.dueAt).toBeGreaterThan(Date.now() + 30_000);
    }
    expect(all.map((r) => r.dueAt)).toEqual([...all.map((r) => r.dueAt)].sort((x, y) => x - y));

    expect(await bus.retries('users', 'flaky', { count: 2 })).toHaveLength(2);
    expect(await bus.retries('users', 'flaky', { count: 2, offset: 2 })).toHaveLength(1);
    expect(await bus.retries('users', 'nobody')).toEqual([]);
    await expect(bus.retries('users', 'flaky', { offset: -1 })).rejects.toThrow(/offset/);
  });
});

describe('readPage()', () => {
  it('pages through a topic with a cursor, in both directions', async () => {
    const base = Date.now() - 100_000;
    for (let n = 0; n < 7; n++) await event(`${base + n}-0`, 'e', String(n));
    const bus = createBus();

    const first = await bus.readPage('users', { count: 3 });
    expect(first.events.map((e) => e.payload)).toEqual([0, 1, 2]);
    const second = await bus.readPage('users', { count: 3, after: first.next });
    expect(second.events.map((e) => e.payload)).toEqual([3, 4, 5]);
    const third = await bus.readPage('users', { count: 3, after: second.next });
    expect(third.events.map((e) => e.payload)).toEqual([6]);
    expect(third.next).toBeUndefined();

    const newest = await bus.readPage('users', { count: 3, reverse: true });
    expect(newest.events.map((e) => e.payload)).toEqual([6, 5, 4]);
    const older = await bus.readPage('users', { count: 3, reverse: true, after: newest.next });
    expect(older.events.map((e) => e.payload)).toEqual([3, 2, 1]);
    expect(await bus.read('users', { count: 2 })).toHaveLength(2);
  });

  it('filters by event name, scanning past other events, and stops at maxScan', async () => {
    const base = Date.now() - 100_000;
    for (let n = 0; n < 300; n++)
      await event(`${base + n}-0`, n === 250 ? 'rare' : 'common', String(n));
    const bus = createBus();

    const found = await bus.readPage('users', { eventName: 'rare', count: 5 });
    expect(found.events.map((e) => e.payload)).toEqual([250]);
    expect(found.next).toBeUndefined();

    // a small scan budget does not reach it, and says where to continue
    const limited = await bus.readPage('users', { eventName: 'rare', count: 5, maxScan: 100 });
    expect(limited.events).toEqual([]);
    expect(limited.next).toBeDefined();
    const resumed = await bus.readPage('users', {
      eventName: 'rare',
      count: 5,
      maxScan: 200,
      after: limited.next,
    });
    expect(resumed.events.map((e) => e.payload)).toEqual([250]);

    const commons = await bus.readPage('users', { eventName: 'common', count: 3, reverse: true });
    expect(commons.events.map((e) => e.payload)).toEqual([299, 298, 297]);
  });

  it('validates its arguments', async () => {
    const bus = createBus();
    await expect(bus.readPage('users', { count: 1001 })).rejects.toThrow(/between 1 and 1000/);
    await expect(bus.readPage('users', { maxScan: 0, eventName: 'x' })).rejects.toThrow(/maxScan/);
    await expect(bus.readPage('users', { after: 'nope' })).rejects.toThrow(EventLaneError);
  });
});

describe('dead letters: page, count, retryMany', () => {
  it('pages, filters by consumer and event name, and counts', async () => {
    const bus = createBus();
    await deadLetter('a', 'x');
    await deadLetter('a', 'y');
    await deadLetter('b', 'x');
    await deadLetter('b', 'x');
    await deadLetter('a', 'x');

    expect(await bus.dlq.count('users')).toBe(5);
    expect(await bus.dlq.count('users', { consumerName: 'a' })).toBe(3);
    expect(await bus.dlq.count('users', { eventName: 'x' })).toBe(4);
    expect(await bus.dlq.count('users', { consumerName: 'b', eventName: 'y' })).toBe(0);
    expect(await bus.dlq.count('nothing')).toBe(0);

    const first = await bus.dlq.page('users', { count: 2 });
    expect(first.entries).toHaveLength(2);
    const second = await bus.dlq.page('users', { count: 2, after: first.next });
    const third = await bus.dlq.page('users', { count: 2, after: second.next });
    expect([...first.entries, ...second.entries, ...third.entries].map((l) => l.id)).toEqual(
      (await bus.dlq.list('users')).map((l) => l.id),
    );

    const onlyAX = await bus.dlq.list('users', { consumerName: 'a', eventName: 'x' });
    expect(onlyAX).toHaveLength(2);
    const newest = await bus.dlq.list('users', { reverse: true, count: 1 });
    expect(newest[0]?.consumerName).toBe('a');
    expect(await bus.dlq.list('users', { count: 0 }).catch((e) => e.message)).toMatch(/count/);
  });

  it('get returns one dead letter by id', async () => {
    const bus = createBus();
    const id = (await deadLetter('a', 'x', '7-7')) as string;
    expect(await bus.dlq.get('users', id)).toMatchObject({
      id,
      consumerName: 'a',
      eventName: 'x',
      originalId: '7-7',
      error: 'boom',
    });
    expect(await bus.dlq.get('users', '1-1')).toBeUndefined();
    expect(await bus.dlq.get('nothing', id)).toBeUndefined();
  });

  it('purge can delete listed ids (unknown ids count as zero) and rejects malformed ones', async () => {
    const bus = createBus();
    const a = (await deadLetter('a', 'x')) as string;
    await deadLetter('a', 'y');
    expect(await bus.dlq.purge('users', { ids: [a, '9-9'] })).toBe(1);
    expect((await bus.dlq.list('users')).map((l) => l.eventName)).toEqual(['y']);
    expect(await bus.dlq.purge('users', { ids: [] })).toBe(0);
    await expect(bus.dlq.purge('users', { ids: ['nope'] })).rejects.toThrow(
      /Invalid dead-letter id/,
    );
  });

  it('purge can filter by event name', async () => {
    const bus = createBus();
    await deadLetter('a', 'x');
    await deadLetter('a', 'y');
    await deadLetter('b', 'x');
    expect(await bus.dlq.purge('users', { eventName: 'x' })).toBe(2);
    expect((await bus.dlq.list('users')).map((l) => l.eventName)).toEqual(['y']);
  });

  it('retryMany re-delivers by consumer, by event name and by id, each to its own consumer', async () => {
    const bus = createBus();
    const a1 = await deadLetter('a', 'x', '1-1');
    await deadLetter('a', 'y', '1-2');
    await deadLetter('b', 'x', '1-3');
    await deadLetter('b', 'y', '1-4');

    expect(await bus.dlq.retryMany('users', { ids: [a1 as string, '9-9'] })).toBe(1);
    expect(await retryCount('users', 'a')).toBe(1);

    expect(await bus.dlq.retryMany('users', { consumerName: 'b', eventName: 'x' })).toBe(1);
    expect(await retryCount('users', 'b')).toBe(1);
    expect(await dlqLength('users')).toBe(2);

    expect(await bus.dlq.retryMany('users')).toBe(2);
    expect(await dlqLength('users')).toBe(0);
    expect(await retryCount('users', 'a')).toBe(2);
    expect(await retryCount('users', 'b')).toBe(2);
    expect(await bus.dlq.retryMany('users')).toBe(0);
  });

  it('retried dead letters are handled by a running consumer with a fresh attempt count', async () => {
    const bus = createBus({ consumerName: 'workers' });
    const seen: Array<{ eventName: string; attempt: number }> = [];
    bus.on(
      'users',
      (_p, meta) => void seen.push({ eventName: meta.eventName, attempt: meta.attempt }),
    );
    await bus.start();
    await deadLetter('workers', 'user.created', '1-1');
    await deadLetter('workers', 'user.deleted', '1-2');

    expect(await bus.dlq.retryMany('users', { consumerName: 'workers' })).toBe(2);
    await waitFor(() => seen.length === 2);
    expect(seen.map((s) => s.attempt)).toEqual([1, 1]);
    expect(seen.map((s) => s.eventName).sort()).toEqual(['user.created', 'user.deleted']);
  });
});

describe('eventStatus()', () => {
  it('reports where one event stands for each consumer', async () => {
    const done = createBus({ consumerName: 'done-consumer' });
    done.on('users', () => {});
    const retrying = createBus({
      consumerName: 'retrying-consumer',
      retry: { attempts: 5, backoff: { type: 'fixed', delay: 60_000 } },
    });
    retrying.on('users', () => {
      throw new Error('later');
    });
    const dead = createBus({ consumerName: 'dead-consumer', retry: { attempts: 1 } });
    dead.on('users', () => {
      throw new Error('never');
    });
    await Promise.all([done.start(), retrying.start(), dead.start()]);
    // two consumers that exist but did not handle the event normally
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'stuck-consumer', '$', 'MKSTREAM');
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'behind-consumer', '$', 'MKSTREAM');

    const bus = createBus();
    const id = await bus.emit('users', 'user.created', { n: 1 });
    await raw.call(
      'XREADGROUP',
      'GROUP',
      'stuck-consumer',
      'dead-1',
      'COUNT',
      1,
      'STREAMS',
      `${prefix}:users`,
      '>',
    );
    // let behind-consumer's position stay before the event
    await raw.call('XGROUP', 'SETID', `${prefix}:users`, 'behind-consumer', '0-0');

    await waitFor(async () => {
      const s = await bus.eventStatus('users', id);
      const states = Object.fromEntries(s.consumers.map((c) => [c.consumerName, c.state]));
      return (
        states['retrying-consumer'] === 'retrying' && states['dead-consumer'] === 'dead-letter'
      );
    });

    const status = await bus.eventStatus('users', id);
    expect(status.event).toMatchObject({ id, eventName: 'user.created', payload: { n: 1 } });
    const by = Object.fromEntries(status.consumers.map((c) => [c.consumerName, c]));
    expect(by['done-consumer']?.state).toBe('done');
    expect(by['stuck-consumer']).toMatchObject({
      state: 'pending',
      instanceName: 'dead-1',
      deliveries: 1,
    });
    expect(by['retrying-consumer']).toMatchObject({ state: 'retrying', attempt: 1 });
    expect(by['retrying-consumer']?.dueAt).toBeGreaterThan(Date.now() + 30_000);
    expect(by['dead-consumer']).toMatchObject({ state: 'dead-letter', attempt: 1, error: 'never' });
    expect(by['behind-consumer']?.state).toBe('not-read'); // its read position is before the event
  });

  it('says not-read for a consumer that has not reached the event, and handles unknown events', async () => {
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'lagging', '$', 'MKSTREAM');
    const bus = createBus();
    const id = await bus.emit('users', 'user.created');
    const status = await bus.eventStatus('users', id);
    expect(status.consumers).toEqual([{ consumerName: 'lagging', state: 'not-read' }]);

    // an id that is not in the topic: no event, and positions are still compared
    const unknown = await bus.eventStatus('users', '1-1');
    expect(unknown.event).toBeUndefined();
    expect(unknown.consumers[0]?.state).toBe('not-read'); // the group started at 0-0 (empty topic)

    expect(await bus.eventStatus('nothing', '1-1')).toEqual({ event: undefined, consumers: [] });
    await expect(bus.eventStatus('users', 'nope')).rejects.toThrow(/eventId/);
  });

  it('pending counts agree with stats', async () => {
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'workers', '$', 'MKSTREAM');
    const bus = createBus();
    for (let n = 0; n < 3; n++) await bus.emit('users', 'user.created');
    await readAs('users', 'workers', 'dead-1');
    expect(await pendingCount('users', 'workers')).toBe(3);
    expect((await bus.pending('users', 'workers')).length).toBe(3);
    expect((await bus.stats('users')).consumers[0]?.pending).toBe(3);
  });
});
