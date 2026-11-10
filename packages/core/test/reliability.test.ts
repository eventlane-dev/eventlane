import { describe, expect, it } from 'vitest';
import { EventLaneError, type EventMetadata } from '../src';
import { backoffDelay, DEFAULT_RETRY } from '../src/retry';
import { sleep, useBuses, waitFor } from './helpers';

const { prefix, raw, createBus, pendingCount, retryCount, dlqLength } = useBuses();

/** Reads an event as a "dead" instance would: delivered, never acknowledged. */
async function readAsDeadInstance(topicName: string, consumerName: string, instance = 'dead-1') {
  const key = `${prefix}:${topicName}`;
  await raw.call('XREADGROUP', 'GROUP', consumerName, instance, 'COUNT', 10, 'STREAMS', key, '>');
}

async function createConsumer(topicName: string, consumerName: string) {
  await raw.call('XGROUP', 'CREATE', `${prefix}:${topicName}`, consumerName, '$', 'MKSTREAM');
}

describe('backoff', () => {
  it('fixed waits the same delay, exponential doubles up to maxDelay', () => {
    const fixed = { ...DEFAULT_RETRY, type: 'fixed' as const, delay: 100 };
    expect([1, 2, 3].map((n) => backoffDelay(fixed, n))).toEqual([100, 100, 100]);
    const exp = { ...DEFAULT_RETRY, delay: 100, maxDelay: 350 };
    expect([1, 2, 3, 4].map((n) => backoffDelay(exp, n))).toEqual([100, 200, 350, 350]);
  });

  it('validates the retry options', () => {
    expect(() => createBus({ retry: { attempts: 0 } })).toThrow(EventLaneError);
    expect(() => createBus({ retry: { backoff: { type: 'weird' as never } } })).toThrow(/backoff/);
  });
});

describe('retries', () => {
  it('retries a failing handler with an increasing attempt number until it succeeds', async () => {
    const bus = createBus({ consumerName: 'flaky' });
    const attempts: number[] = [];
    bus.on('users', 'user.created', (_payload, meta: EventMetadata) => {
      attempts.push(meta.attempt);
      if (meta.attempt < 3) throw new Error('not yet');
    });
    await bus.start();
    const id = await bus.emit('users', 'user.created', { n: 1 });

    await waitFor(() => attempts.length === 3);
    expect(attempts).toEqual([1, 2, 3]);
    await waitFor(async () => (await pendingCount('users', 'flaky')) === 0);
    await waitFor(async () => (await retryCount('users', 'flaky')) === 0);
    expect(await dlqLength('users')).toBe(0);
    expect(id).toMatch(/^\d+-\d+$/);
  });

  it('keeps the event id stable across retries and waits at least the backoff', async () => {
    const bus = createBus({
      consumerName: 'timed',
      retry: { attempts: 3, backoff: { type: 'fixed', delay: 300 } },
    });
    const seen: Array<{ id: string; at: number }> = [];
    bus.on('users', (_p, meta) => {
      seen.push({ id: meta.id, at: Date.now() });
      if (meta.attempt < 2) throw new Error('once');
    });
    await bus.start();
    const id = await bus.emit('users', 'user.created');
    await waitFor(() => seen.length === 2);
    expect(seen.map((s) => s.id)).toEqual([id, id]);
    expect((seen[1]?.at ?? 0) - (seen[0]?.at ?? 0)).toBeGreaterThanOrEqual(280);
  });

  it('does not block later events while one waits for its retry', async () => {
    const bus = createBus({
      consumerName: 'flowing',
      retry: { attempts: 3, backoff: { type: 'fixed', delay: 400 } },
    });
    const order: number[] = [];
    bus.on('users', (payload: { n: number }, meta) => {
      order.push(payload.n);
      if (payload.n === 1 && meta.attempt === 1) throw new Error('first fails once');
    });
    await bus.start();
    await bus.emit('users', 'user.created', { n: 1 });
    await bus.emit('users', 'user.created', { n: 2 });
    await waitFor(() => order.length === 3);
    expect(order).toEqual([1, 2, 1]);
  });

  it('retries only the consumer that failed, not the others', async () => {
    const flaky = createBus({ consumerName: 'flaky' });
    const steady = createBus({ consumerName: 'steady' });
    const flakyAttempts: number[] = [];
    let steadyCalls = 0;
    flaky.on('users', (_p, meta) => {
      flakyAttempts.push(meta.attempt);
      if (meta.attempt === 1) throw new Error('boom');
    });
    steady.on('users', () => {
      steadyCalls++;
    });
    await Promise.all([flaky.start(), steady.start()]);
    await flaky.emit('users', 'user.created');

    await waitFor(() => flakyAttempts.length === 2);
    await sleep(200);
    expect(steadyCalls).toBe(1);
  });

  it('a subscription can override the retry policy', async () => {
    const bus = createBus({ consumerName: 'strict' });
    let calls = 0;
    bus.on(
      'users',
      () => {
        calls++;
        throw new Error('always');
      },
      { retry: { attempts: 1 } },
    );
    await bus.start();
    await bus.emit('users', 'user.created');
    await waitFor(async () => (await dlqLength('users')) === 1);
    expect(calls).toBe(1);
  });
});

describe('dead-letter stream', () => {
  it('moves the event after the last attempt and records why', async () => {
    const bus = createBus({
      consumerName: 'doomed',
      retry: { attempts: 3, backoff: { type: 'fixed', delay: 30 } },
    });
    let calls = 0;
    bus.on('users', () => {
      calls++;
      throw new Error('always broken');
    });
    await bus.start();
    const id = await bus.emit('users', 'user.created', { n: 1 }, { headers: { h: '1' } });

    await waitFor(async () => (await dlqLength('users')) === 1);
    expect(calls).toBe(3);
    await waitFor(async () => (await pendingCount('users', 'doomed')) === 0);
    expect(await retryCount('users', 'doomed')).toBe(0);

    const [letter] = await bus.dlq.list('users');
    expect(letter).toMatchObject({
      topicName: 'users',
      eventName: 'user.created',
      payload: { n: 1 },
      headers: { h: '1' },
      consumerName: 'doomed',
      attempt: 3,
      error: 'always broken',
      originalId: id,
    });
    expect(letter?.stack).toContain('always broken');
    expect(letter?.failedAt).toBeGreaterThan(0);
  });

  it('dead-letters undecodable entries instead of leaving them stuck', async () => {
    const bus = createBus({ consumerName: 'strict' });
    bus.on('users', () => {});
    await bus.start();
    await raw.xadd(`${prefix}:users`, '*', 'event', 'user.created', 'payload', 'not json');

    await waitFor(async () => (await dlqLength('users')) === 1);
    const [letter] = await bus.dlq.list('users');
    expect(letter?.error).toMatch(/undecodable/);
    expect(await pendingCount('users', 'strict')).toBe(0);
  });

  it('list filters by consumer and purge removes entries', async () => {
    const a = createBus({ consumerName: 'a', retry: { attempts: 1 } });
    const b = createBus({ consumerName: 'b', retry: { attempts: 1 } });
    for (const bus of [a, b]) {
      bus.on('users', () => {
        throw new Error('x');
      });
    }
    await Promise.all([a.start(), b.start()]);
    await a.emit('users', 'user.created');
    await waitFor(async () => (await dlqLength('users')) === 2);

    expect(await a.dlq.list('users', { consumerName: 'a' })).toHaveLength(1);
    expect(await a.dlq.list('users', { consumerName: 'b' })).toHaveLength(1);
    expect(await a.dlq.purge('users', { consumerName: 'a' })).toBe(1);
    expect(await dlqLength('users')).toBe(1);
    expect(await a.dlq.purge('users')).toBe(1);
    expect(await dlqLength('users')).toBe(0);
  });

  it('dlq.retry re-delivers to the failing consumer only, with a fresh attempt budget', async () => {
    const broken = createBus({ consumerName: 'broken', retry: { attempts: 1 } });
    const other = createBus({ consumerName: 'other' });
    let fixed = false;
    const seen: number[] = [];
    let otherCalls = 0;
    broken.on('users', (_p, meta) => {
      if (!fixed) throw new Error('not fixed');
      seen.push(meta.attempt);
    });
    other.on('users', () => {
      otherCalls++;
    });
    await Promise.all([broken.start(), other.start()]);
    await broken.emit('users', 'user.created', { n: 1 });
    await waitFor(async () => (await dlqLength('users')) === 1);

    fixed = true;
    const [letter] = await broken.dlq.list('users');
    await broken.dlq.retry('users', letter?.id as string);

    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([1]);
    expect(await dlqLength('users')).toBe(0);
    await sleep(100);
    expect(otherCalls).toBe(1);
    await expect(broken.dlq.retry('users', '1-1')).rejects.toThrow(/No dead-letter entry/);
  });
});

describe('crash recovery (XAUTOCLAIM)', () => {
  it('claims an event a dead instance never acknowledged', async () => {
    await createConsumer('users', 'workers');
    const bus = createBus({ consumerName: 'workers', claimIdleMs: 250 });
    const attempts: number[] = [];
    bus.on('users', (_p, meta) => void attempts.push(meta.attempt));
    const id = await bus.emit('users', 'user.created', { n: 1 });
    await readAsDeadInstance('users', 'workers');
    expect(await pendingCount('users', 'workers')).toBe(1);

    await bus.start();
    await waitFor(() => attempts.length === 1);
    expect(attempts[0]).toBeGreaterThanOrEqual(2); // the dead delivery counts as an attempt
    await waitFor(async () => (await pendingCount('users', 'workers')) === 0);
    expect(id).toBeTruthy();
  });

  it('does not claim events that are still within the idle window', async () => {
    await createConsumer('users', 'workers');
    const bus = createBus({ consumerName: 'workers', claimIdleMs: 60_000 });
    let calls = 0;
    bus.on('users', () => void calls++);
    await bus.emit('users', 'user.created');
    await readAsDeadInstance('users', 'workers');
    await bus.start();
    await sleep(500);
    expect(calls).toBe(0);
    expect(await pendingCount('users', 'workers')).toBe(1);
  });

  it('dead-letters a poison event that keeps crashing instances', async () => {
    await createConsumer('users', 'workers');
    const bus = createBus({
      consumerName: 'workers',
      claimIdleMs: 150,
      retry: { attempts: 2, backoff: { type: 'fixed', delay: 10 } },
    });
    let calls = 0;
    bus.on('users', () => void calls++);
    await bus.emit('users', 'user.created');
    await readAsDeadInstance('users', 'workers', 'dead-1');
    // a second instance claimed it and died too: two deliveries so far
    await sleep(200);
    await raw.call('XAUTOCLAIM', `${prefix}:users`, 'workers', 'dead-2', 100, '0-0', 'COUNT', 10);
    await sleep(200);

    await bus.start();
    await waitFor(async () => (await dlqLength('users')) === 1);
    expect(calls).toBe(0);
    const [letter] = await bus.dlq.list('users');
    expect(letter?.error).toMatch(/exceeded 2 delivery attempts/);
    expect(await pendingCount('users', 'workers')).toBe(0);
  });

  it('recovers a retry that was claimed by an instance that died (lease expiry)', async () => {
    const bus = createBus({ consumerName: 'workers', claimIdleMs: 300 });
    // a retry member that was leased (claimed) and then abandoned: due, attempt 2 already counted
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'workers', '$', 'MKSTREAM');
    const member = JSON.stringify({
      id: '1-1',
      event: 'user.created',
      payload: '{"n":1}',
      headers: '{}',
      attempt: 1,
    });
    await raw.zadd(`${prefix}:users:workers:retry`, Date.now() - 1000, member);

    const attempts: number[] = [];
    bus.on('users', (_p, meta) => void attempts.push(meta.attempt));
    await bus.start();
    await waitFor(() => attempts.length === 1);
    expect(attempts).toEqual([2]);
    await waitFor(async () => (await retryCount('users', 'workers')) === 0);
  });
});

describe('dedup', () => {
  const dedupKey = (consumer: string, id: string, topic = 'users') =>
    `${prefix}:dedup:${topic}:${consumer}:${id}`;

  it('skips an event this consumer already processed (redelivery after a lost ack)', async () => {
    await createConsumer('users', 'workers');
    const bus = createBus({ consumerName: 'workers', claimIdleMs: 250 });
    let calls = 0;
    bus.on('users', () => void calls++, { dedup: true });
    const id = await bus.emit('users', 'user.created');
    await readAsDeadInstance('users', 'workers');
    await raw.set(dedupKey('workers', id), 'd', 'EX', 60); // processed, but the ack never happened

    await bus.start();
    await waitFor(async () => (await pendingCount('users', 'workers')) === 0);
    expect(calls).toBe(0);
  });

  it('marks events done after success and runs the handler once', async () => {
    const bus = createBus({ consumerName: 'workers' });
    let calls = 0;
    bus.on('users', () => void calls++, { dedup: true });
    await bus.start();
    const id = await bus.emit('users', 'user.created');
    await waitFor(() => calls === 1);
    await waitFor(async () => (await raw.get(dedupKey('workers', id))) === 'd');
    const ttl = await raw.ttl(dedupKey('workers', id));
    expect(ttl).toBeGreaterThan(0);
  });

  it('leaves an event alone while another instance holds a live lease, then runs it after expiry', async () => {
    await createConsumer('users', 'workers');
    const bus = createBus({ consumerName: 'workers', claimIdleMs: 250 });
    let calls = 0;
    bus.on('users', () => void calls++, { dedup: true });
    const id = await bus.emit('users', 'user.created');
    await readAsDeadInstance('users', 'workers');
    await raw.set(dedupKey('workers', id), 'p', 'PX', 700); // "processing" lease by someone else

    await bus.start();
    await sleep(450);
    expect(calls).toBe(0);
    expect(await pendingCount('users', 'workers')).toBe(1);

    await waitFor(() => calls === 1, 4000); // lease expired: handled
    await waitFor(async () => (await pendingCount('users', 'workers')) === 0);
  });

  it('releases the marker when the handler fails so the retry runs', async () => {
    const bus = createBus({ consumerName: 'workers' });
    const attempts: number[] = [];
    bus.on(
      'users',
      (_p, meta) => {
        attempts.push(meta.attempt);
        if (meta.attempt === 1) throw new Error('first try fails');
      },
      { dedup: true },
    );
    await bus.start();
    await bus.emit('users', 'user.created');
    await waitFor(() => attempts.length === 2);
    expect(attempts).toEqual([1, 2]);
  });
});

describe('producer idempotency', () => {
  it('stores an event once per idempotencyKey and returns the original id', async () => {
    const bus = createBus();
    const first = await bus.emit('users', 'user.created', { n: 1 }, { idempotencyKey: 'req-1' });
    const second = await bus.emit('users', 'user.created', { n: 1 }, { idempotencyKey: 'req-1' });
    const other = await bus.emit('users', 'user.created', { n: 2 }, { idempotencyKey: 'req-2' });
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(await raw.xlen(`${prefix}:users`)).toBe(2);
    expect(await raw.ttl(`${prefix}:idem:users:req-1`)).toBeGreaterThan(0);
  });

  it('is atomic under concurrent emits with the same key', async () => {
    const bus = createBus();
    const ids = await Promise.all(
      Array.from({ length: 10 }, () =>
        bus.emit('users', 'user.created', null, { idempotencyKey: 'burst' }),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await raw.xlen(`${prefix}:users`)).toBe(1);
  });

  it('scopes keys to the topic and rejects empty keys', async () => {
    const bus = createBus();
    await bus.emit('users', 'x', null, { idempotencyKey: 'k' });
    await bus.emit('orders', 'x', null, { idempotencyKey: 'k' });
    // ids are per stream and may coincide, so check that both topics stored their event
    expect(await raw.xlen(`${prefix}:users`)).toBe(1);
    expect(await raw.xlen(`${prefix}:orders`)).toBe(1);
    await expect(bus.emit('users', 'x', null, { idempotencyKey: '' })).rejects.toThrow(
      /idempotencyKey/,
    );
  });
});
