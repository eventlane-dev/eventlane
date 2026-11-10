# Reliability

Terms: [Concepts](concepts.md).

EventLane is at-least-once. This page explains what happens when things go wrong.

## Life of an event

1. `emit` stores the event in its topic (`XADD` to `events:<topicName>`).
2. Each consumer's read loop receives it (`XREADGROUP`); it becomes *pending* for the instance that got it.
3. Every handler that matches succeeds: acknowledged (`XACK`). The event is done for that consumer.
4. A handler fails: [retry](#retries-and-backoff), and finally the [dead-letter stream](#dead-letter-stream).
5. The instance dies mid-handling: see [Crash recovery](#crash-recovery).

An event that no subscription of the consumer matches is acknowledged right away.

## Retries and backoff

When a handler throws (or rejects), EventLane schedules a retry and releases the failed delivery in one atomic step:

- the event goes into a per-consumer sorted set (`events:<topicName>:<consumerName>:retry`), scored by the time it is due (taken from Redis, so instances with skewed clocks agree);
- every instance of that consumer polls the set every `retryPollMs` and claims due entries with a lease of `claimIdleMs`, so each retry runs on exactly one instance and survives a crash of that instance;
- the handler sees the new attempt number in `meta.attempt`; `meta.id` stays the id of the original event.

Retries are delivered **only to the consumer that failed**, straight from its retry set. They are not added back to the topic, so other consumers never see duplicates.

```ts
retry: {
  attempts: 5,                                              // total tries incl. the first (1 = no retry)
  backoff: { type: 'exponential', delay: 1000, maxDelay: 60_000 },
}
```

`type: 'fixed'` waits `delay` ms every time. Exponential waits `delay * 2^(attempt-1)` capped at `maxDelay`. Set it on the bus, or per subscription (`bus.on(..., { retry })`). When one event matches several subscriptions, the first one that sets its own `retry` decides the policy for that event.

If an event matches several subscriptions and any handler fails, the retry runs **all** matching handlers again, including those that succeeded. Keep handlers idempotent, or split the work across consumers. EventLane logs a warning at startup when it sees such an overlap (needs a `logger`; the Nest module logs through the Nest `Logger` by default).

A retrying event does not block later events: they keep flowing while it waits for its backoff.

## Dead-letter stream

After the last failed attempt the event is written to `events:<topicName>:dlq` with the consumer, the attempt count, the error message and stack, and removed from the consumer's pending list, in one atomic step. It is not retried automatically. Events that cannot be decoded (invalid JSON, missing event name) go there immediately.

```ts
const entries = await bus.dlq.list('users', { consumerName: 'notifications', count: 50 });
await bus.dlq.retry('users', entries[0].id);   // re-deliver to that consumer only
await bus.dlq.retryMany('users', { consumerName: 'notifications' });   // all of that consumer's
await bus.dlq.purge('users', { consumerName: 'notifications' });   // or purge('users') for all
```

- `dlq.list(topicName, { consumerName?, eventName?, count?, reverse?, after?, maxScan? })` returns `DeadLetter` objects, oldest first (newest first with `reverse`): `id`, `eventName`, `payload`, `headers`, `consumerName`, `attempt`, `error`, `stack`, `originalId`, `failedAt`. `count` defaults to 100 and is at most 1000.
- `dlq.get(topicName, id)` returns one dead letter, or `undefined`.
- `dlq.page(topicName, filter)` is `list` plus the cursor of the next page: `{ entries, next }`. Pass `next` as `after` for the following page; `next` is `undefined` at the end. Filtering by consumer or event name is bounded by `maxScan` (default 10000) like [`readPage`](operations.md#paging-and-filtering): a page can be short while `next` is set.
- `dlq.count(topicName, { consumerName?, eventName? })` returns how many dead letters there are. Without a filter it is a single `XLEN`.
- `dlq.retry(topicName, id)` puts the event back into the failing consumer's retry set with a fresh attempt budget (attempt counting restarts at 1) and deletes it from the dead-letter stream. A running instance of that consumer picks it up on its next retry poll. Other consumers do not receive it again.
- `dlq.retryMany(topicName, { ids?, consumerName?, eventName? })` does that for many at once, each to the consumer that failed it: the listed `ids`, or everything matching the filters (every dead letter without options). It returns how many were re-delivered; unknown ids are skipped.
- `dlq.purge(topicName, { ids?, consumerName?, eventName? })` deletes the listed `ids`, or the entries matching the filters (all of them without options), and returns how many.
- The dead-letter stream is capped at about `dlqMaxLen` entries (default 10000).

## Crash recovery

If an instance dies after reading an event but before acknowledging it, the event stays in Redis' Pending Entries List (PEL). Every instance runs `XAUTOCLAIM` every `claimIntervalMs` to take over entries that have been idle longer than `claimIdleMs` (default 60 s) and handles them. The number of times Redis delivered the entry becomes the attempt number, so a dead delivery counts as an attempt. A poison event that crashes every instance that touches it therefore cannot loop forever: once its attempts exceed the limit it goes to the dead-letter stream with an explanatory error.

A retry that was claimed by an instance that then died is recovered the same way: its lease expires after `claimIdleMs` and another instance claims it, again counting the lost delivery as an attempt.

Set `claimIdleMs` above your slowest handler's expected duration. Otherwise a slow but healthy handler can have its event claimed and run a second time on another instance.

## Deduplication

Because delivery is at-least-once, a handler can see the same event twice (for example the process finished the work, then crashed before acknowledging). Enable dedup per subscription:

```ts
bus.on('orders', 'order.placed', handler, { dedup: true });
```

Dedup is per topic, consumer and event id, and it works as a small state machine on `events:dedup:<topicName>:<consumerName>:<eventId>`:

| State | Meaning | What a delivery does |
|---|---|---|
| none | not seen | takes a lease (`processing`, lasts `claimIdleMs`) and runs the handlers |
| `processing` | another instance is handling it now | skips without acknowledging; if that instance dies the lease expires and the event is claimed again |
| `done` (kept for `dedupTtlSeconds`, default 86400) | handlers already succeeded | acknowledges without running the handlers |

If the handlers fail, the marker is removed so the retry runs. If any matching subscription of the consumer enables `dedup`, the event is deduplicated for the whole consumer.

Producers can pass `idempotencyKey` to `emit` to avoid storing the same event twice (for example when a client retries an HTTP request):

```ts
const id = await bus.emit('orders', 'order.placed', order, { idempotencyKey: `order-${order.id}` });
```

The first `emit` stores the event; later calls with the same key (per topic) within `dedupTtlSeconds` store nothing and return the original id. The check and the write are atomic, so concurrent calls are safe.

Dedup narrows the window but does not make side effects exactly-once (a handler can still be interrupted after its side effect and before it finishes). The best protection is an idempotent handler: upserts, unique constraints, "already sent" checks.

## Graceful shutdown

`close()` stops reading, waits for running handlers up to `shutdownTimeoutMs` (default 10 s), then disconnects. Anything unfinished stays pending (or leased) and is claimed by another instance. After a clean stop the instance is removed from the consumer (`XGROUP DELCONSUMER`), but only if it holds no pending events: removing a consumer with pending events would discard them.

## Ordering

EventLane does **not** guarantee that events are handled in the order they were emitted, except in one narrow case: one running instance of the consumer, `concurrency: 1` (the default) and handlers that do not fail. Everything else reorders:

| Situation | What happens |
|---|---|
| Several instances of one consumer | Each event goes to one instance and the instances work in parallel, so event 2 can finish before event 1. |
| `concurrency` above 1 | Handlers of one instance overlap. |
| A handler fails | The event is retried after its backoff and later events run in the meantime. |
| A consumer is replayed or recovers a dead instance's events | Those events are handled again, after newer ones. |

There are no partitions or ordering keys, so you cannot ask for "in order per order id" and still run several instances.

When order matters, make the handler tolerate out-of-order delivery instead of relying on the sequence:

- Put a version number or a timestamp in the payload and ignore an event that is older than what you already stored (`UPDATE ... WHERE version < $new`).
- Make events carry the full new state rather than a delta, so the latest one wins.
- Treat "event arrives for an entity that does not exist yet" as retryable (throw, and it is retried later).

If you really need strict order, run one instance of that consumer with `concurrency: 1`, and handle failures inside the handler (catch and log) instead of throwing, because a thrown error moves the event to the back of the line.

## What is lost if Redis is lost

Topics live in Redis memory. With `appendonly yes` you lose at most about a second of events on a crash; without persistence you lose everything. See [Operations](operations.md#redis-setup).

## When Redis is unavailable

- **Consumers** keep their position. The connection is retried automatically; when Redis is back, reading continues and events that were in flight are recovered as in [crash recovery](#crash-recovery). Nothing acknowledged is lost, and some events may be delivered again.
- **`emit`** does not drop events and does not return early: while Redis is down the command waits in the client's queue and completes after the reconnect. If the outage outlasts the client's retry limit (`maxRetriesPerRequest`, 20 attempts by default for ioredis), `emit` rejects. Your code must handle that rejection: an event that was never stored is not retried by EventLane. See [Patterns](patterns.md#outbox) for how to keep a database change and its event consistent.
- **Data loss in Redis** (for example `FLUSHALL`, or a restart without persistence) removes the topics and consumers. Running consumers notice and recreate themselves, and new events are delivered; the lost events are gone.

These cases are covered by tests that start, kill and restart their own `redis-server` (skipped when the binary is not installed).
