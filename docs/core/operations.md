# Operations

Running EventLane in production: Redis setup, retention, removing things and performance. To look at what is stored, see [Inspecting](inspecting.md); before going live read the [Production checklist](production-checklist.md). Terms: [Concepts](concepts.md).

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
- The dead-letter queue has its own cap, `dlqMaxLen` (default 10000).

## Removing things

```ts
await bus.removeConsumer('users', 'old-service');          // true if something was removed
await bus.deleteTopic('users', { confirm: true });         // destructive
```

- `removeConsumer` deletes the consumer's read position, pending list and retry set. Events stay in the topic. Stop running instances of that consumer first: they would recreate it at the end of the topic.
- `deleteTopic` removes the topic, its dead-letter queue, every consumer's retry set and the topic's producer idempotency keys. It throws unless you pass `{ confirm: true }`.

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
