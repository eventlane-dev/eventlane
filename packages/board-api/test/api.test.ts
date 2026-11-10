import { randomBytes } from 'node:crypto';
import { EventLaneBus } from '@eventlane/core';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { type BoardOptions, createBoardApi } from '../src';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6390';
const prefix = `b-${randomBytes(4).toString('hex')}`;
const raw = new Redis(REDIS_URL);
const buses: EventLaneBus[] = [];

const createBus = (options: Record<string, unknown> = {}) => {
  const bus = new EventLaneBus({
    redisUrl: REDIS_URL,
    prefix,
    blockTimeMs: 200,
    retryPollMs: 20,
    claimIntervalMs: 100,
    claimIdleMs: 1000,
    shutdownTimeoutMs: 2000,
    ...options,
  } as ConstructorParameters<typeof EventLaneBus>[0]);
  buses.push(bus);
  return bus;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

afterEach(async () => {
  await Promise.all(buses.splice(0).map((bus) => bus.close()));
  const keys = await raw.keys(`${prefix}*`);
  if (keys.length > 0) await raw.del(...keys);
});
afterAll(async () => {
  await raw.quit();
});

// biome-ignore lint/suspicious/noExplicitAny: test helper over loosely typed JSON responses
type Body = Record<string, any>;
const call = async (
  api: ReturnType<typeof createBoardApi>,
  path: string,
  query: Record<string, string> = {},
  method = 'GET',
  rawRequest?: unknown,
): Promise<{ status: number; body: Body }> => {
  const response = await api.handle({ method, path, query, raw: rawRequest });
  return { status: response.status, body: response.body as Body };
};

/** A topic with events, a pending event, a retry and a dead letter, for several consumers. */
async function seed() {
  const bus = createBus();
  const ids: string[] = [];
  // consumers that exist before the events
  await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'lagging', '$', 'MKSTREAM');
  await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'stuck', '$', 'MKSTREAM');
  const retrying = createBus({
    consumerName: 'retrying',
    retry: { attempts: 5, backoff: { type: 'fixed', delay: 60_000 } },
  });
  retrying.on('users', 'user.created', () => {
    throw new Error('later');
  });
  const dead = createBus({ consumerName: 'dead', retry: { attempts: 1 } });
  dead.on('users', 'user.created', () => {
    throw new Error('never');
  });
  await Promise.all([retrying.start(), dead.start()]);

  for (let n = 1; n <= 3; n++) {
    ids.push(
      await bus.emit(
        'users',
        n === 3 ? 'user.deleted' : 'user.created',
        { n, email: `u${n}@x.io` },
        { headers: { token: 's3cret' } },
      ),
    );
  }
  await raw.call(
    'XREADGROUP',
    'GROUP',
    'stuck',
    'dead-1',
    'COUNT',
    1,
    'STREAMS',
    `${prefix}:users`,
    '>',
  );
  await bus.emit('orders', 'order.placed', { orderId: 1 });
  await waitFor(async () => {
    const stats = await bus.stats('users');
    const by = Object.fromEntries(stats.consumers.map((c) => [c.consumerName, c]));
    return by.retrying?.retrying === 2 && stats.deadLetters === 2;
  });
  return { bus, ids };
}

describe('config and routing', () => {
  it('is read-only by default and names the buses', async () => {
    const api = createBoardApi({ buses: createBus() });
    expect(api.config).toEqual({ readOnly: true, hidePayloads: false, buses: ['default'] });
    expect(await call(api, '/config')).toEqual({ status: 200, body: api.config });

    const many = createBoardApi({ buses: [createBus(), createBus({ prefix: `${prefix}-2` })] });
    expect(many.config.buses).toEqual(['bus-1', 'bus-2']);
    const named = createBoardApi({ buses: { prod: createBus(), staging: createBus() } });
    expect(named.config.buses).toEqual(['prod', 'staging']);
    expect(() => createBoardApi({ buses: [] })).toThrow(/at least one bus/);
  });

  it('answers 404 for unknown routes and buses, and 403 for writes it will not do', async () => {
    const api = createBoardApi({ buses: createBus() });
    expect((await call(api, '/nothing')).status).toBe(404);
    expect((await call(api, '/topics/users/nothing')).status).toBe(404);
    expect(await call(api, '/topics', { bus: 'nope' })).toMatchObject({
      status: 404,
      body: { error: 'unknown bus "nope"' },
    });
    expect(await call(api, '/topics', {}, 'POST')).toMatchObject({
      status: 403,
      body: { error: 'the board is read-only' },
    });
    const writable = createBoardApi({ buses: createBus(), readOnly: false });
    expect((await call(writable, '/topics', {}, 'DELETE')).status).toBe(403); // no CSRF header
  });

  it('picks the bus with ?bus=', async () => {
    const one = createBus();
    const two = createBus({ prefix: `${prefix}-2` });
    await two.emit('billing', 'invoice.paid');
    const api = createBoardApi({ buses: { one, two } });
    expect((await call(api, '/topics')).body.topics).toEqual([]);
    const second = await call(api, '/topics', { bus: 'two' });
    expect(second.body.bus).toBe('two');
    expect(second.body.topics.map((t: Body) => t.topicName)).toEqual(['billing']);
    await two.deleteTopic('billing', { confirm: true });
  });
});

describe('topics', () => {
  it('lists topics with sizes, consumers, lag, pending, retrying and dead letters', async () => {
    const { bus } = await seed();
    const api = createBoardApi({ buses: bus });
    const { status, body } = await call(api, '/topics');
    expect(status).toBe(200);
    const by = Object.fromEntries(body.topics.map((t: Body) => [t.topicName, t]));
    expect(Object.keys(by).sort()).toEqual(['orders', 'users']);
    expect(by.users).toMatchObject({
      length: 3,
      deadLetters: 2,
      consumers: 4,
      retrying: 2,
      needsAttention: true,
    });
    expect(by.users.pending).toBe(1);
    expect(by.users.lag).toBeGreaterThanOrEqual(2);
    expect(by.users.oldest).toBeLessThanOrEqual(by.users.newest);
    expect(by.orders).toMatchObject({ length: 1, consumers: 0, needsAttention: false });
  });

  it('shows one topic with its instances, and 404s for an unknown one', async () => {
    const { bus } = await seed();
    const api = createBoardApi({ buses: bus });
    const { status, body } = await call(api, '/topics/users');
    expect(status).toBe(200);
    expect(body.topic.length).toBe(3);
    const stuck = body.topic.consumers.find((c: Body) => c.consumerName === 'stuck');
    expect(stuck.instanceDetails).toEqual([
      expect.objectContaining({ instanceName: 'dead-1', pending: 1 }),
    ]);
    expect((await call(api, '/topics/ghost')).status).toBe(404);
    expect((await call(api, '/topics/bad:name')).status).toBe(400);
  });
});

describe('events', () => {
  it('pages newest first with previews, filters by event name, and validates', async () => {
    const { bus, ids } = await seed();
    const api = createBoardApi({ buses: bus });

    const first = await call(api, '/topics/users/events', { limit: '2' });
    expect(first.body.events.map((e: Body) => e.id)).toEqual([ids[2], ids[1]]);
    expect(first.body.events[0]).toMatchObject({
      eventName: 'user.deleted',
      preview: '{"n":3,"email":"u3@x.io"}',
      payloadHidden: false,
    });
    expect(first.body.events[0].payload).toBeUndefined();
    const second = await call(api, '/topics/users/events', { limit: '2', cursor: first.body.next });
    expect(second.body.events.map((e: Body) => e.id)).toEqual([ids[0]]);
    expect(second.body.next).toBeNull();

    const filtered = await call(api, '/topics/users/events', { eventName: 'user.created' });
    expect(filtered.body.events.map((e: Body) => e.eventName)).toEqual([
      'user.created',
      'user.created',
    ]);
    const oldestFirst = await call(api, '/topics/users/events', { reverse: 'false' });
    expect(oldestFirst.body.events[0].id).toBe(ids[0]);

    expect((await call(api, '/topics/users/events', { limit: '0' })).status).toBe(400);
    expect((await call(api, '/topics/users/events', { limit: '500' })).status).toBe(400);
    expect((await call(api, '/topics/users/events', { cursor: 'nope' })).status).toBe(400);
  });

  it('shows one event with its state for every consumer', async () => {
    const { bus, ids } = await seed();
    const api = createBoardApi({ buses: bus });
    const { status, body } = await call(api, `/topics/users/events/${ids[0]}`);
    expect(status).toBe(200);
    expect(body.event).toMatchObject({
      id: ids[0],
      topicName: 'users',
      eventName: 'user.created',
      payload: { n: 1, email: 'u1@x.io' },
      headers: { token: 's3cret' },
      payloadHidden: false,
      payloadTruncated: false,
    });
    const states = Object.fromEntries(body.consumers.map((c: Body) => [c.consumerName, c.state]));
    expect(states).toMatchObject({
      stuck: 'pending',
      retrying: 'retrying',
      dead: 'dead-letter',
      lagging: 'not-read',
    });

    const missing = await call(api, '/topics/users/events/1-1');
    expect(missing.body.event).toBeNull();
    expect((await call(api, '/topics/users/events/not-an-id')).status).toBe(400);
  });
});

describe('consumers', () => {
  it('lists pending and retrying events', async () => {
    const { bus, ids } = await seed();
    const api = createBoardApi({ buses: bus });

    const pending = await call(api, '/topics/users/consumers/stuck/pending');
    expect(pending.body.events).toEqual([
      expect.objectContaining({ id: ids[0], eventName: 'user.created', instanceName: 'dead-1' }),
    ]);
    expect(
      (await call(api, '/topics/users/consumers/stuck/pending', { instance: 'other' })).body.events,
    ).toEqual([]);

    const retrying = await call(api, '/topics/users/consumers/retrying/retrying', { limit: '1' });
    expect(retrying.body.events).toHaveLength(1);
    expect(retrying.body.events[0]).toMatchObject({ eventName: 'user.created', attempt: 1 });
    const rest = await call(api, '/topics/users/consumers/retrying/retrying', { offset: '1' });
    expect(rest.body.events).toHaveLength(1);

    expect((await call(api, '/topics/users/consumers/ghost/pending')).body.events).toEqual([]);
    expect((await call(api, '/topics/users/consumers/stuck/pending', { limit: 'x' })).status).toBe(
      400,
    );
  });
});

describe('dead letters', () => {
  it('lists dead letters with filters and the total, and shows one with its stack', async () => {
    const { bus } = await seed();
    const api = createBoardApi({ buses: bus });

    const { status, body } = await call(api, '/topics/users/dlq');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({
      eventName: 'user.created',
      attempt: expect.any(Number),
    });
    expect(body.entries[0].stack).toBeUndefined();
    expect(body.entries[0].payload).toBeUndefined();
    expect(body.entries.map((e: Body) => e.consumerName)).toEqual(['dead', 'dead']);

    const byConsumer = await call(api, '/topics/users/dlq', { consumer: 'dead' });
    expect(byConsumer.body.entries.every((e: Body) => e.consumerName === 'dead')).toBe(true);
    expect((await call(api, '/topics/users/dlq', { eventName: 'nothing' })).body.entries).toEqual(
      [],
    );

    const one = await call(api, `/topics/users/dlq/${body.entries[0].id}`);
    expect(one.status).toBe(200);
    expect(one.body.deadLetter).toMatchObject({
      consumerName: 'dead',
      error: 'never',
      topicName: 'users',
    });
    expect(one.body.deadLetter.stack).toContain('never');
    expect(one.body.deadLetter.payload).toMatchObject({ email: expect.any(String) });
    expect((await call(api, '/topics/users/dlq/1-1')).status).toBe(404);
  });
});

describe('privacy', () => {
  it('hidePayloads removes payloads everywhere but keeps metadata', async () => {
    const { bus, ids } = await seed();
    const api = createBoardApi({ buses: bus, hidePayloads: true });
    expect(api.config.hidePayloads).toBe(true);

    const list = await call(api, '/topics/users/events');
    expect(list.body.events[0]).toMatchObject({ preview: '', payloadHidden: true });
    expect(list.body.events[0].size).toBeGreaterThan(0);
    const detail = await call(api, `/topics/users/events/${ids[0]}`);
    expect(detail.body.event).toMatchObject({ payload: null, payloadHidden: true });
    const dlq = await call(api, '/topics/users/dlq');
    expect(dlq.body.entries[0]).toMatchObject({ preview: '', payloadHidden: true });
    const letter = await call(api, `/topics/users/dlq/${dlq.body.entries[0].id}`);
    expect(letter.body.deadLetter).toMatchObject({ payload: null, payloadHidden: true });
  });

  it('redact rewrites payloads and headers before they leave', async () => {
    const { bus, ids } = await seed();
    const redact: NonNullable<BoardOptions['redact']> = (event) => ({
      ...event,
      payload: { ...(event.payload as object), email: '***' },
      headers: { ...event.headers, token: '***' },
    });
    const api = createBoardApi({ buses: bus, redact });

    const detail = await call(api, `/topics/users/events/${ids[0]}`);
    expect(detail.body.event.payload).toEqual({ n: 1, email: '***' });
    expect(detail.body.event.headers).toEqual({ token: '***' });
    expect((await call(api, '/topics/users/events')).body.events[0].preview).toContain(
      '"email":"***"',
    );
    const dlq = await call(api, '/topics/users/dlq');
    expect(dlq.body.entries[0].preview).toContain('***');
    const letter = await call(api, `/topics/users/dlq/${dlq.body.entries[0].id}`);
    expect(letter.body.deadLetter.payload.email).toBe('***');
  });

  it('does not send payloads larger than maxPayloadBytes', async () => {
    const bus = createBus();
    const id = await bus.emit('users', 'big', { blob: 'x'.repeat(1000) });
    const api = createBoardApi({ buses: bus, maxPayloadBytes: 100 });
    const detail = await call(api, `/topics/users/events/${id}`);
    expect(detail.body.event).toMatchObject({ payload: null, payloadTruncated: true });
    expect(detail.body.event.size).toBeGreaterThan(1000);
    const list = await call(api, '/topics/users/events');
    expect(list.body.events[0].preview.length).toBeLessThanOrEqual(201);
  });
});

describe('authorize and errors', () => {
  it('asks authorize with the host request and the read action', async () => {
    const bus = createBus();
    const calls: Array<{ request: unknown; action: string }> = [];
    let allow = false;
    const api = createBoardApi({
      buses: bus,
      authorize: (request, action) => {
        calls.push({ request, action });
        return allow;
      },
    });
    const hostRequest = { user: 'ada' };

    expect(await call(api, '/topics', {}, 'GET', hostRequest)).toMatchObject({
      status: 403,
      body: { error: 'forbidden' },
    });
    expect(calls).toEqual([{ request: hostRequest, action: 'read' }]);
    allow = true;
    expect((await call(api, '/topics', {}, 'GET', hostRequest)).status).toBe(200);
  });

  it('answers 500 and reports unexpected errors without leaking them', async () => {
    const errors: unknown[] = [];
    const api = createBoardApi({
      buses: createBus(),
      authorize: () => {
        throw new Error('secret internals');
      },
      onError: (error) => errors.push(error),
    });
    expect(await call(api, '/topics')).toEqual({ status: 500, body: { error: 'internal error' } });
    expect(errors).toHaveLength(1);
  });

  it('limits how many requests run at once', async () => {
    const bus = createBus();
    let active = 0;
    let max = 0;
    const slow = new Proxy(bus, {
      get(target, prop, receiver) {
        if (prop === 'topics') {
          return async () => {
            active++;
            max = Math.max(max, active);
            await sleep(30);
            active--;
            return [];
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const api = createBoardApi({ buses: slow, concurrency: 2 });
    const responses = await Promise.all(Array.from({ length: 6 }, () => call(api, '/topics')));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(max).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Writes

const ORIGIN_HEADERS = { 'x-eventlane-board': '1', host: 'board.test' };

const write = async (
  api: ReturnType<typeof createBoardApi>,
  method: string,
  path: string,
  body?: unknown,
  extra: { query?: Record<string, string>; headers?: Record<string, string>; raw?: unknown } = {},
): Promise<{ status: number; body: Body }> => {
  const response = await api.handle({
    method,
    path,
    query: extra.query,
    headers: extra.headers ?? ORIGIN_HEADERS,
    body,
    raw: extra.raw,
  });
  return { status: response.status, body: response.body as Body };
};

const addDeadLetter = (consumer: string, eventName: string, topic = 'users') =>
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
    '1-1',
    'failedAt',
    String(Date.now()),
  ) as Promise<string>;

const writable = (extra: Partial<BoardOptions> = {}) =>
  createBoardApi({ buses: createBus(), readOnly: false, ...extra });

describe('writes: access', () => {
  it('refuses every write while read-only, even with the header', async () => {
    const api = createBoardApi({ buses: createBus() });
    expect(await write(api, 'POST', '/topics/users/dlq/retry', { all: true })).toMatchObject({
      status: 403,
      body: { error: 'the board is read-only' },
    });
  });

  it('refuses writes without the CSRF header, from other origins and cross-site', async () => {
    const api = writable();
    const body = { all: true };
    const post = (headers: Record<string, string>) =>
      write(api, 'POST', '/topics/users/dlq/retry', body, { headers });

    expect((await post({ host: 'board.test' })).status).toBe(403);
    expect((await post({ ...ORIGIN_HEADERS, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ ...ORIGIN_HEADERS, origin: 'null' })).status).toBe(403);
    expect((await post({ ...ORIGIN_HEADERS, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ ...ORIGIN_HEADERS, origin: 'https://board.test' })).status).toBe(200);
    expect((await post({ 'X-EventLane-Board': '1', Host: 'board.test' })).status).toBe(200);
    expect((await post(ORIGIN_HEADERS)).status).toBe(200); // no Origin: not a browser

    const proxied = writable({ allowedOrigins: ['https://admin.example.com'] });
    expect(
      (
        await write(proxied, 'POST', '/topics/users/dlq/retry', body, {
          headers: { ...ORIGIN_HEADERS, origin: 'https://admin.example.com' },
        })
      ).status,
    ).toBe(200);
  });

  it('asks authorize for the specific action and tells onWrite what was done', async () => {
    const seen: string[] = [];
    const audit: Body[] = [];
    const api = writable({
      authorize: (_request, action) => {
        seen.push(action);
        return action !== 'dlq.purge';
      },
      onWrite: (entry) => void audit.push(entry),
    });
    await addDeadLetter('a', 'x');
    const hostRequest = { user: 'ada' };

    const retry = await write(
      api,
      'POST',
      '/topics/users/dlq/retry',
      { consumer: 'a' },
      { raw: hostRequest },
    );
    expect(retry).toMatchObject({ status: 200, body: { retried: 1 } });
    const purge = await write(
      api,
      'POST',
      '/topics/users/dlq/purge',
      { all: true },
      { raw: hostRequest },
    );
    expect(purge).toMatchObject({ status: 403, body: { error: 'forbidden' } });

    expect(seen).toEqual(['dlq.retry', 'dlq.purge']);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'dlq.retry',
      bus: 'default',
      topicName: 'users',
      consumerName: 'a',
      detail: { consumer: 'a', retried: 1 },
      request: hostRequest,
    });
  });

  it('a failing onWrite does not fail the write and is reported', async () => {
    const errors: unknown[] = [];
    const api = writable({
      onWrite: () => {
        throw new Error('audit down');
      },
      onError: (e) => errors.push(e),
    });
    await addDeadLetter('a', 'x');
    expect((await write(api, 'POST', '/topics/users/dlq/retry', { all: true })).status).toBe(200);
    expect(errors).toHaveLength(1);
  });

  it('validates bodies and routes', async () => {
    const api = writable();
    expect((await write(api, 'POST', '/topics/users/dlq/retry', [])).status).toBe(400);
    expect((await write(api, 'POST', '/topics/users/dlq/retry', { ids: 'x' })).status).toBe(400);
    expect((await write(api, 'POST', '/topics/users/dlq/retry', { consumer: 5 })).status).toBe(400);
    expect((await write(api, 'POST', '/topics/users/dlq/nothing', {})).status).toBe(404);
    expect((await write(api, 'PUT', '/topics/users', {})).status).toBe(404);
    expect((await write(api, 'POST', '/nothing', {})).status).toBe(404);
    expect(
      (await write(api, 'POST', '/topics/users/dlq/retry', { all: true }, { query: { bus: 'x' } }))
        .status,
    ).toBe(404);
  });
});

describe('writes: dead letters', () => {
  it('retry needs a scope: ids, consumer, event name or all', async () => {
    const api = writable();
    const a = await addDeadLetter('a', 'x');
    await addDeadLetter('a', 'y');
    await addDeadLetter('b', 'x');

    expect((await write(api, 'POST', '/topics/users/dlq/retry', {})).status).toBe(400);
    expect((await write(api, 'POST', '/topics/users/dlq/retry', { ids: [a] })).body).toEqual({
      retried: 1,
    });
    expect((await write(api, 'POST', '/topics/users/dlq/retry', { consumer: 'b' })).body).toEqual({
      retried: 1,
    });
    expect((await write(api, 'POST', '/topics/users/dlq/retry', { eventName: 'y' })).body).toEqual({
      retried: 1,
    });
    expect(await raw.xlen(`${prefix}:users:dlq`)).toBe(0);
    expect(await raw.zcard(`${prefix}:users:a:retry`)).toBe(2);
    expect(await raw.zcard(`${prefix}:users:b:retry`)).toBe(1);
    expect((await write(api, 'POST', '/topics/users/dlq/retry', { all: true })).body).toEqual({
      retried: 0,
    });
  });

  it('purge needs a scope too, and deletes only what matches', async () => {
    const api = writable();
    const a = await addDeadLetter('a', 'x');
    await addDeadLetter('a', 'y');
    await addDeadLetter('b', 'x');

    expect((await write(api, 'POST', '/topics/users/dlq/purge', {})).status).toBe(400);
    expect((await write(api, 'POST', '/topics/users/dlq/purge', { ids: [a, '9-9'] })).body).toEqual(
      { purged: 1 },
    );
    expect((await write(api, 'POST', '/topics/users/dlq/purge', { consumer: 'b' })).body).toEqual({
      purged: 1,
    });
    expect(await raw.xlen(`${prefix}:users:dlq`)).toBe(1);
    expect((await write(api, 'POST', '/topics/users/dlq/purge', { all: true })).body).toEqual({
      purged: 1,
    });
    expect(await raw.xlen(`${prefix}:users:dlq`)).toBe(0);
  });

  it('a retried dead letter is handled by the running consumer', async () => {
    const bus = createBus({ consumerName: 'workers' });
    const seen: number[] = [];
    bus.on('users', (_p, meta) => void seen.push(meta.attempt));
    await bus.start();
    await addDeadLetter('workers', 'user.created');
    const api = createBoardApi({ buses: bus, readOnly: false });
    expect(
      (await write(api, 'POST', '/topics/users/dlq/retry', { consumer: 'workers' })).body,
    ).toEqual({ retried: 1 });
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([1]);
  });
});

describe('writes: consumers and topics', () => {
  it('replay previews how many events are affected, then moves the consumer', async () => {
    const bus = createBus();
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) ids.push(await bus.emit('users', 'user.created', { n }));
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'reporting', '$');
    const api = createBoardApi({ buses: bus, readOnly: false });
    const lag = async () => (await bus.stats('users')).consumers[0]?.lag;
    const replay = (from: unknown, dryRun?: boolean) =>
      write(api, 'POST', '/topics/users/consumers/reporting/replay', { from, dryRun });

    expect(await lag()).toBe(0);
    expect((await replay('0', true)).body).toEqual({ applied: false, affected: 5, capped: false });
    expect(await lag()).toBe(0); // a preview changes nothing
    expect((await replay(ids[2], true)).body).toMatchObject({ applied: false, affected: 3 });
    expect((await replay('0')).body).toEqual({ applied: true, affected: 5, capped: false });
    expect(await lag()).toBe(5);
    expect((await replay('$')).body).toEqual({ applied: true, affected: 0, capped: false });
    expect(await lag()).toBe(0);
    expect((await replay(ids[3])).body).toMatchObject({ applied: true, affected: 2 });
    expect(await lag()).toBe(2);
    expect((await replay(Number(ids[4]?.split('-')[0]))).status).toBe(200);

    expect((await replay('nope')).status).toBe(400);
    expect((await replay(undefined)).status).toBe(400);
    expect((await replay(-1)).status).toBe(400);
  });

  it('removing a consumer needs its name as confirmation', async () => {
    const bus = createBus();
    await raw.call('XGROUP', 'CREATE', `${prefix}:users`, 'old', '$', 'MKSTREAM');
    const api = createBoardApi({ buses: bus, readOnly: false });
    const remove = (confirm?: string) =>
      write(api, 'DELETE', '/topics/users/consumers/old', undefined, {
        query: confirm ? { confirm } : {},
      });

    expect((await remove()).status).toBe(400);
    expect((await remove('other')).status).toBe(400);
    expect((await bus.stats('users')).consumers).toHaveLength(1);
    expect((await remove('old')).body).toEqual({ removed: true });
    expect((await bus.stats('users')).consumers).toHaveLength(0);
    expect((await remove('old')).body).toEqual({ removed: false });
  });

  it('deleting a topic needs its name as confirmation and removes everything', async () => {
    const bus = createBus();
    await bus.emit('users', 'user.created', null, { idempotencyKey: 'k' });
    await addDeadLetter('a', 'x');
    const api = createBoardApi({ buses: bus, readOnly: false });
    const remove = (confirm?: string) =>
      write(api, 'DELETE', '/topics/users', undefined, { query: confirm ? { confirm } : {} });

    expect((await remove()).status).toBe(400);
    expect((await remove('orders')).status).toBe(400);
    expect(await bus.topics()).toEqual(['users']);
    expect((await remove('users')).body).toEqual({ deleted: true });
    expect(await bus.topics()).toEqual([]);
    expect(await raw.keys(`${prefix}:*`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Rate limit, search, test events

describe('rate limit', () => {
  const hit = (api: ReturnType<typeof createBoardApi>, client?: string) =>
    api.handle({ method: 'GET', path: '/config', client });

  it('answers 429 with Retry-After once a client is over its share, per client', async () => {
    const api = createBoardApi({ buses: createBus(), rateLimit: { max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i++) expect((await hit(api, '10.0.0.1')).status).toBe(200);
    const limited = await hit(api, '10.0.0.1');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'too many requests, slow down' });
    expect(Number(limited.headers?.['Retry-After'])).toBeGreaterThanOrEqual(1);
    expect((await hit(api, '10.0.0.2')).status).toBe(200); // another client is unaffected
  });

  it('refills over time, so a steady pace is fine', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const api = createBoardApi({ buses: createBus(), rateLimit: { max: 2, windowMs: 1000 } });
      expect((await hit(api, 'a')).status).toBe(200);
      expect((await hit(api, 'a')).status).toBe(200);
      expect((await hit(api, 'a')).status).toBe(429);
      vi.setSystemTime(1_000_600); // 600 ms refill 1.2 tokens
      expect((await hit(api, 'a')).status).toBe(200);
      expect((await hit(api, 'a')).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is on by default, can be switched off, and checks its settings', async () => {
    const byDefault = createBoardApi({ buses: createBus() });
    let refused = 0;
    for (let i = 0; i < 150; i++) if ((await hit(byDefault, 'x')).status === 429) refused++;
    expect(refused).toBeGreaterThan(0);

    const off = createBoardApi({ buses: createBus(), rateLimit: false });
    for (let i = 0; i < 300; i++) expect((await hit(off, 'x')).status).toBe(200);
    expect(() => createBoardApi({ buses: createBus(), rateLimit: { max: 0 } })).toThrow(
      /rateLimit/,
    );
  });

  it('applies before authorization, so it protects it too', async () => {
    let asked = 0;
    const api = createBoardApi({
      buses: createBus(),
      rateLimit: { max: 1, windowMs: 60_000 },
      authorize: () => {
        asked++;
        return true;
      },
    });
    await hit(api, 'a');
    await hit(api, 'a');
    expect(asked).toBe(1);
  });
});

describe('searching events', () => {
  async function seedSearch() {
    const bus = createBus();
    await bus.emit(
      'users',
      'user.created',
      { email: 'ada@example.com', plan: 'pro' },
      { headers: { trace: 'abc-1' } },
    );
    await bus.emit('users', 'user.created', { email: 'grace@example.com', plan: 'free' });
    await bus.emit('users', 'user.deleted', { email: 'ada@other.org' });
    return bus;
  }

  it('finds events by text in the name, payload or headers, case-insensitively', async () => {
    const api = createBoardApi({ buses: await seedSearch() });
    const find = async (search: string, extra: Record<string, string> = {}) =>
      (await call(api, '/topics/users/events', { search, ...extra })).body;

    expect((await find('ADA@')).events.map((e: Body) => e.eventName)).toEqual([
      'user.deleted',
      'user.created',
    ]);
    expect((await find('plan":"free')).events).toHaveLength(1);
    expect((await find('abc-1')).events).toHaveLength(1); // a header
    expect((await find('user.deleted')).events).toHaveLength(1); // the event name
    expect((await find('nothing like this')).events).toEqual([]);
    expect((await find('ada@', { eventName: 'user.created' })).events).toHaveLength(1);
    expect((await find('ada@')).scanned).toBe(3);
  });

  it('pages through matches with the cursor', async () => {
    const api = createBoardApi({ buses: await seedSearch() });
    const first = (await call(api, '/topics/users/events', { search: 'example.com', limit: '1' }))
      .body;
    expect(first.events).toHaveLength(1);
    expect(first.next).toBeTruthy();
    const second = (
      await call(api, '/topics/users/events', {
        search: 'example.com',
        limit: '1',
        cursor: first.next,
      })
    ).body;
    expect(second.events).toHaveLength(1);
    expect(second.events[0].id).not.toBe(first.events[0].id);
    const third = (
      await call(api, '/topics/users/events', {
        search: 'example.com',
        limit: '1',
        cursor: second.next,
      })
    ).body;
    expect(third.events).toEqual([]);
    expect(third.next).toBeNull();
  });

  it('searches what is shown: a redacted value cannot be found, and hidden payloads cannot be searched', async () => {
    const bus = await seedSearch();
    const redacted = createBoardApi({
      buses: bus,
      redact: (event) => ({ ...event, payload: { ...(event.payload as object), email: '***' } }),
    });
    expect((await call(redacted, '/topics/users/events', { search: 'ada@' })).body.events).toEqual(
      [],
    );
    expect(
      (await call(redacted, '/topics/users/events', { search: '***' })).body.events,
    ).toHaveLength(3);

    const hidden = createBoardApi({ buses: bus, hidePayloads: true });
    expect(await call(hidden, '/topics/users/events', { search: 'ada' })).toMatchObject({
      status: 400,
      body: { error: 'search is not available while payloads are hidden' },
    });
  });
});

describe('writes: test events', () => {
  it('stores an event with a payload and headers', async () => {
    const bus = createBus();
    const api = createBoardApi({ buses: bus, readOnly: false });
    const result = await write(api, 'POST', '/topics/users/events', {
      eventName: 'user.created',
      payload: { id: 1 },
      headers: { source: 'board' },
    });
    expect(result.status).toBe(200);
    expect(result.body.id).toMatch(/^\d+-\d+$/);
    const [event] = await bus.read('users');
    expect(event).toMatchObject({
      id: result.body.id,
      eventName: 'user.created',
      payload: { id: 1 },
      headers: { source: 'board' },
    });
    expect((await write(api, 'POST', '/topics/users/events', { eventName: 'x' })).status).toBe(200); // no payload is fine
  });

  it('validates the input, asks authorize for event.emit and is audited', async () => {
    const seen: string[] = [];
    const audit: Body[] = [];
    const api = createBoardApi({
      buses: createBus(),
      readOnly: false,
      authorize: (_request, action) => {
        seen.push(action);
        return true;
      },
      onWrite: (entry) => void audit.push(entry),
    });
    expect((await write(api, 'POST', '/topics/users/events', {})).status).toBe(400);
    expect((await write(api, 'POST', '/topics/users/events', { eventName: 5 })).status).toBe(400);
    expect(
      (await write(api, 'POST', '/topics/users/events', { eventName: 'x'.repeat(201) })).status,
    ).toBe(400);
    expect(
      (await write(api, 'POST', '/topics/users/events', { eventName: 'x', headers: { a: 1 } }))
        .status,
    ).toBe(400);
    expect((await write(api, 'POST', '/topics/bad:topic/events', { eventName: 'x' })).status).toBe(
      400,
    );
    expect((await write(api, 'POST', '/topics/users/events', { eventName: 'ok' })).status).toBe(
      200,
    );
    expect(seen).toContain('event.emit');
    expect(audit.at(-1)).toMatchObject({
      action: 'event.emit',
      topicName: 'users',
      detail: { eventName: 'ok' },
    });
  });

  it('is refused while read-only', async () => {
    const api = createBoardApi({ buses: createBus() });
    expect((await write(api, 'POST', '/topics/users/events', { eventName: 'x' })).status).toBe(403);
  });
});
