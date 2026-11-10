# Operations

Terms: [Concepts](concepts.md).

## Redis setup

- Redis 6.2+ (7+ recommended).
- **Persistence on.** Use AOF (`appendonly yes`, `appendfsync everysec`) or a managed Redis with persistence. Without it events vanish on restart.
- **No eviction for event data.** Set `maxmemory-policy noeviction` on the instance holding topics, or use a separate Redis from your cache. An evicting policy can silently delete topics.
- Memory is the limit: topics are stored in RAM, so check [retention](#retention) (there is a default).
- Use a separate Redis database or a unique `prefix` if the instance is shared (default prefix is `events`, a generic name, so set your own on shared instances).
- Single node or Sentinel. Redis Cluster is not supported.

## Retention

Every topic is trimmed on `emit`. By default a topic keeps about the **latest 1 000 000 events**, so memory cannot grow without bound. Change the default for all topics with `retention`, or per topic (keys of `topics` are `topicName`s):

```ts
new EventLaneBus({
  redisUrl,
  topics: {
    users:  { retention: { maxLen: 100_000 } },             // keep about the last 100k events
    orders: { retention: { maxAgeMs: 7 * 24 * 3600_000 } }, // keep about 7 days
    audit:  { retention: false },                           // keep everything
  },
});
```

`retention: false` (on the bus or on a topic) turns trimming off: the topic then grows until Redis runs out of memory, so use it only for small or externally trimmed topics.

- Trimming happens on every `emit` to that topic (including idempotent emits), so a topic nobody emits to is never trimmed. Topics that already hold more than the limit are trimmed down by the next `emit`.
- It is **approximate** (`MAXLEN ~` / `MINID ~`): Redis removes whole internal blocks of about 100 events, which keeps it cheap. A topic can therefore hold somewhat more than `maxLen`, and slightly older events than `maxAgeMs`, but never less than the limit.
- If both limits are set, both apply (the age limit runs as a follow-up `XTRIM`).
- Age is measured against the emitting process' clock, since event ids carry a timestamp.
- Warning: trimming can delete events that a slow consumer has not read yet. Watch [lag](#stats-and-lag) and size retention with a margin.
- The dead-letter stream has its own cap, `dlqMaxLen` (default 10000).

## Listing topics

```ts
await bus.topics();   // ['orders', 'users']
```

Returns the names of the topics under the bus `prefix`, sorted. It finds them with `SCAN` (never `KEYS`), looking only at streams, and leaves out the dead-letter streams, retry sets and other helper keys. A topic exists from its first `emit` (or when a consumer is created).

## Peeking at events

```ts
const latest = await bus.read('users', { count: 20, reverse: true });          // newest first
const range  = await bus.read('users', { from: '1762725960000-0', count: 100 });
const day    = await bus.read('users', { from: new Date('2026-11-01'), to: new Date('2026-11-02') });
```

`bus.read(topicName, { count?, reverse?, from?, to? })` returns `{ id, topicName, eventName, payload, headers, timestamp }[]` without affecting any consumer. `from` and `to` are inclusive and take an event id, a timestamp in ms or a `Date`; by default the range is the whole topic. `count` defaults to 100 and is at most 1000. A payload that is not valid JSON is returned as raw text. You can also use `redis-cli XRANGE events:users - + COUNT 10`.

### Paging and filtering

`bus.readPage` takes the same options plus `eventName` and `after`, and returns the events together with the cursor of the next page:

```ts
let page = await bus.readPage('orders', { eventName: 'order.placed', count: 50, reverse: true });
while (page.events.length > 0 || page.next !== undefined) {
  show(page.events);
  if (page.next === undefined) break;
  page = await bus.readPage('orders', {
    eventName: 'order.placed', count: 50, reverse: true, after: page.next,
  });
}
```

- `after` continues after that event id, in the direction of the read (older events with `reverse`). It overrides `from` (`to` with `reverse`).
- `next` is `undefined` when the range is exhausted.
- Filtering by `eventName` is done while scanning, so it is **bounded**: it looks at most at `maxScan` events (default 10000). When the budget runs out, the page can be short or even empty but `next` is set: call again with `after: next` to continue. This keeps a rare event name from turning one request into a scan of the whole topic.

## Replay

Move a consumer's read position to reprocess history, or to skip it:

```ts
await bus.replay('users', { consumerName: 'reporting', from: '0' });                  // from the beginning
await bus.replay('users', { consumerName: 'reporting', from: new Date('2026-11-01') });
await bus.replay('users', { consumerName: 'reporting', from: '1762725960000-0' });    // from an event id
await bus.replay('users', { consumerName: 'reporting', from: '$' });                  // skip everything stored so far
```

- The first event delivered afterwards is the first one **at or after** `from` (an event id is included).
- `consumerName` defaults to the bus `consumerName`. A consumer that does not exist yet is created at that position.
- Only the named consumer is affected. Running instances of it follow immediately, with no restart.
- Events that are already pending or waiting for a retry are not touched. Handlers will see old events again, so [dedup](reliability.md#deduplication) markers (kept for `dedupTtlSeconds`) may make them skip: for a clean reprocess use a new `consumerName`.

## Stats and lag

```ts
const s = await bus.stats('users');
// {
//   topicName: 'users',
//   length: 12840,
//   deadLetters: 1,
//   consumers: [
//     { consumerName: 'notifications', instances: 3, pending: 2, lag: 0,    retrying: 1 },
//     { consumerName: 'reporting',     instances: 1, pending: 0, lag: 5120, retrying: 0 },
//   ],
// }
```

- `length`: events currently stored in the topic.
- `deadLetters`: entries in the topic's dead-letter stream (all consumers).
- `instances`: instances currently attached to the consumer.
- `pending`: delivered but not yet acknowledged.
- `lag`: events in the topic the consumer has not read yet. Exact on Redis 7+; on Redis 6.2 (or when Redis cannot tell) it is counted by scanning and capped at 10000.
- `retrying`: failed events waiting for their next retry.

An unknown topic returns zeros and no consumers. Built on `XLEN`, `XINFO GROUPS` and the retry sets. EventLane ships no HTTP endpoints or dashboards in this package: expose `stats()` from your own health or metrics route.

### Instances

`stats` is cheap enough to poll. To see the instances of each consumer, ask for them (one extra command per consumer):

```ts
const s = await bus.stats('users', { instances: true });
// s.consumers[0].instanceDetails: [
//   { instanceName: 'web-1-4312-a9f3', pending: 0, idleMs: 120 },
//   { instanceName: 'web-2-977-c01d',  pending: 2, idleMs: 48210 },
// ]
```

`idleMs` is the time since the instance last read or acknowledged anything. An instance that stays idle for longer than `claimIdleMs` while it holds pending events is probably dead, and its events are about to be [claimed](reliability.md#crash-recovery).

## Pending and retrying events

Two views explain a consumer's `pending` and `retrying` counts.

```ts
await bus.pending('users', 'notifications', { count: 50 });
// [{ id, eventName, instanceName: 'web-2-977-c01d', idleMs: 48210, deliveries: 1, timestamp }]

await bus.retries('users', 'notifications', { count: 50 });
// [{ id, eventName, attempt: 2, dueAt: 1762726020000, timestamp }]
```

- `pending(topicName, consumerName, { count?, after?, instanceName? })`: events delivered to an instance and not acknowledged, oldest first. `deliveries` counts every delivery, including to instances that died; `eventName` is `undefined` if the event was trimmed from the topic while pending. Page with `after` (the id of the last event you have). A consumer that does not exist returns an empty list.
- `retries(topicName, consumerName, { count?, offset? })`: failed events waiting for their next retry, soonest first. `attempt` is how many deliveries were made so far (1 after the first failure) and `dueAt` is when the retry is due, in ms since epoch. Page with `offset`. An event whose retry is being handled right now is shown with its due time moved to the end of its lease.

## Where one event stands

```ts
const status = await bus.eventStatus('orders', '1762725960000-0');
// {
//   event: { id, eventName: 'order.placed', payload, headers, timestamp, topicName },
//   consumers: [
//     { consumerName: 'billing',   state: 'done' },
//     { consumerName: 'emails',    state: 'retrying', attempt: 2, dueAt: 1762726020000 },
//     { consumerName: 'webhooks',  state: 'dead-letter', attempt: 5, error: 'HTTP 503' },
//     { consumerName: 'reporting', state: 'pending', instanceName: 'web-2-977-c01d', idleMs: 48210, deliveries: 1 },
//     { consumerName: 'newcomer',  state: 'not-read' },
//   ],
// }
```

For every consumer of the topic, `state` is one of:

| State | Meaning |
|---|---|
| `not-read` | The consumer's read position has not reached the event yet. |
| `pending` | Delivered to an instance and not acknowledged (`instanceName`, `idleMs`, `deliveries`). |
| `retrying` | Failed and waiting for a retry (`attempt`, `dueAt`). |
| `dead-letter` | Exhausted its retries (`attempt`, `error`). |
| `done` | Nothing is waiting for this consumer: it handled the event, or the consumer started after it. |

`event` is `undefined` when the event is not in the topic (never existed or was trimmed); the consumer states are still reported. The retry sets are searched up to their first 5000 members and the dead-letter stream is read through once, so use it for a single event, not in a loop over a topic.

## Removing things

```ts
await bus.removeConsumer('users', 'old-service');          // true if something was removed
await bus.deleteTopic('users', { confirm: true });         // destructive
```

- `removeConsumer` deletes the consumer's read position, pending list and retry set. Events stay in the topic. Stop running instances of that consumer first: they would recreate it at the end of the topic.
- `deleteTopic` removes the topic, its dead-letter stream, every consumer's retry set and the topic's producer idempotency keys. It throws unless you pass `{ confirm: true }`.

## Performance

Measured with `pnpm --filter @eventlane/core bench` (after `pnpm build`; it needs Redis): Node 22, Redis 7.2 on the same machine (Apple M2 Pro), 20 000 events with a payload of about 100 bytes, one process. Treat the numbers as an order of magnitude; a networked Redis, larger payloads or a slow handler change them.

| Scenario | Events per second |
|---|---|
| `emit`, awaited one at a time | ~9 000 |
| `emit`, many in flight at once | ~120 000 |
| Consume, `concurrency: 1`, empty handler | ~9 000 |
| Consume, `concurrency: 10`, empty handler | ~50 000 |
| Consume, `concurrency: 50`, empty handler | ~83 000 |
| Consume, `concurrency: 50`, handler waits 5 ms | ~8 000 |
| Consume, `concurrency: 10`, `dedup: true` | ~22 000 |

Emit to handler latency on an idle bus: about 0.2 ms (p99 0.3 ms).

What this means in practice:

- Throughput of a consumer is bounded by `concurrency` divided by handler time (50 handlers of 5 ms is at most 10 000 per second). Raise `concurrency` for handlers that wait on I/O. Note that more concurrency gives up [ordering](reliability.md#ordering).
- Awaiting every `emit` costs one round trip each. Emitting from many request handlers at once pipelines on its own; there is no need to batch.
- `dedup` adds Redis commands per event; use it only for handlers that need it.
