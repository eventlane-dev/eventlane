# Core API (`@eventlane/core`)

Terms: [`topicName`, `eventName`, `consumerName`, `instanceName`](concepts.md). Using it from NestJS is covered in the [NestJS section](../nestjs/guide.md).

## Creating a bus

Connect with a URL **or** with an options object (exactly one of `redisUrl` / `redis`):

```ts
import { EventLaneBus } from '@eventlane/core';

// 1. URL string
const bus = new EventLaneBus({
  redisUrl: 'redis://:password@localhost:6379/0',
  consumerName: 'notifications',      // this process belongs to the "notifications" consumer
});

// 2. connection object
const bus2 = new EventLaneBus({
  redis: { host: 'localhost', port: 6379, username: 'default', password: 'secret', db: 0, tls: {} },
  consumerName: 'notifications',
});

// 3. an existing ioredis client (reused, never closed by EventLane)
const bus3 = new EventLaneBus({ redis: existingIoredis, consumerName: 'notifications' });
```

`redis` takes any [ioredis connection options](configuration.md#redis-connection) (host, port, sentinels, tls, ...) or a ready `ioredis` instance. Passing both `redisUrl` and `redis`, or neither, throws at construction. All options are listed in [Configuration](configuration.md).

## Lifecycle

| Method | Description |
|---|---|
| `await bus.start()` | Connects, creates consumers (Redis consumer groups) if missing, starts the read loops and the retry/claim workers. |
| `await bus.close()` | Graceful shutdown: stops reading, waits for in-flight handlers (up to `shutdownTimeoutMs`), closes connections. Unfinished events stay pending and are claimed by other instances. |

A bus that only emits does not need `start()`; it connects lazily.

## Emitting

```ts
const id = await bus.emit('users', 'user.created', { id: 1 });
const id2 = await bus.emit('users', 'user.created', { id: 2 }, {
  idempotencyKey: 'create-user-2',   // producer-side dedup
  headers: { correlationId: 'abc' },
});
```

`emit(topicName, eventName, payload, options?)` returns the event id (the Redis stream id, e.g. `1762725960000-0`). The promise resolves after Redis has stored the event.

### Headers

`headers` are small pieces of metadata that travel with an event but are not part of its data: a `correlationId` to follow one request through several handlers, a `traceId`, a `tenantId`, who triggered the event. Keep the payload for the business data and use headers for what handlers, logs and tools need around it. Values are strings. A handler reads them from `meta.headers`, and the [dashboard](../dashboard/overview.md) shows them next to the payload (and applies `redact` to them).

```ts
await bus.emit('orders', 'order.placed', order, { headers: { correlationId: req.id, tenantId: 'acme' } });

bus.on('orders', 'order.placed', async (order, meta) => {
  logger.info({ correlationId: meta.headers.correlationId }, 'placing order');
});
```

### Topic-bound emitter

```ts
const users = bus.emitter('users');          // TopicEmitter bound to topic "users"
await users.emit('user.created', { id: 1 }); // no topicName argument
users.on('user.created', handler);
```

This `TopicEmitter` is the same type that `@InjectLaneEmitter('users')` injects in [NestJS](../nestjs/guide.md).

## Listening

```ts
bus.on('users', 'user.created', handler);                  // one eventName
bus.on('users', handler);                                  // every event of the topic
bus.on(['users', 'orders'], handler);                      // several topics
bus.on('users', 'user.created', handler, {
  consumerName: 'webhooks',   // override the bus consumerName for this subscription
  concurrency: 5,
  dedup: true,
  retry: { attempts: 3 },     // override the bus retry policy
});
```

`on` returns an unsubscribe function. Subscriptions added before `start()` begin reading at `start()`; later ones begin immediately.

### Handler

```ts
type Handler<T = any> = (payload: T, meta: EventMetadata) => Promise<void> | void;

interface EventMetadata {
  id: string;            // event id, e.g. '1762725960000-0'
  topicName: string;     // 'users'
  eventName: string;     // 'user.created'
  consumerName: string;  // consumer that received it
  instanceName: string;  // instance that handled it
  streamKey: string;     // full Redis key, e.g. 'events:users'
  timestamp: number;     // ms since epoch (from the event id)
  attempt: number;       // 1 for the first delivery
  headers: Record<string, string>;
}
```

- Resolve the promise: the event is acknowledged.
- Throw / reject: the event is [retried](reliability.md#retries-and-backoff) and eventually moved to the [dead-letter stream](reliability.md#dead-letter-stream).

### Options per subscription

| Option | Default | Meaning |
|---|---|---|
| `consumerName` | bus `consumerName` | Consumer for this subscription. |
| `concurrency` | `1` | Max handlers running at once. Above 1 handlers overlap, so events are not handled in order (see [Ordering](reliability.md#ordering)). |
| `dedup` | `false` | Skip events this consumer already processed successfully. See [Deduplication](reliability.md#deduplication). |
| `startFrom` | `'$'` | Where a **new** consumer starts: `'$'` (only new events) or `'0'` (full history). Ignored if the consumer already exists. |

## Inspecting (see [Operations](operations.md))

```ts
await bus.topics();                                              // ['orders', 'users']
await bus.read('users', { count: 20, reverse: true });
await bus.readPage('users', { eventName: 'user.created', after: cursor });   // { events, next }
await bus.replay('users', { consumerName: 'notifications', from: new Date('2026-11-01') });
await bus.stats('users', { instances: true });
await bus.pending('users', 'notifications');                     // delivered, not acknowledged
await bus.retries('users', 'notifications');                     // waiting for a retry
await bus.eventStatus('users', eventId);                         // state of one event per consumer
await bus.dlq.list('users', { consumerName: 'notifications' });
await bus.dlq.page('users', { eventName: 'user.created', after: cursor });   // { entries, next }
await bus.dlq.count('users');
await bus.dlq.retry('users', entryId);
await bus.dlq.retryMany('users', { consumerName: 'notifications' });
await bus.removeConsumer('users', 'old-service');
await bus.deleteTopic('users', { confirm: true });
```

Each of these is described in [Operations](operations.md) and [Reliability](reliability.md#dead-letter-stream).

## Logging

Pass `logger` (anything with `debug/info/warn/error`) to see what the bus does. The default logger is silent.
