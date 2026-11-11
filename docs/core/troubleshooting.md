# Troubleshooting

The questions that come up most often.

## My handler runs twice for one event

Delivery is **at-least-once**, so this is expected now and then. The usual causes:

- The handler took longer than `claimIdleMs` (60 s by default): another instance took the event over while the first was still working. Raise `claimIdleMs` above your slowest handler.
- A handler failed after doing part of its work, so the event was retried.
- Two handlers of one consumer match the same event; when one fails, **both** run again. EventLane logs a warning about this at startup (set a `logger`). Use separate consumers if they should fail independently.
- A process died before it acknowledged an event, and another instance recovered it.

Make the handler idempotent or use `dedup: true`. See [Reliability](reliability.md).

## Events are emitted, but my handler never runs

Check in this order:

1. Did you call `await bus.start()` (in NestJS: is the module with the handler imported)?
2. Is the **topic name** the same in `emit` and in `on` (`users` is not `user`)? Is the **event name** exactly the same, including case?
3. A consumer that did not exist yet starts at **now**, so events emitted before it first ran are skipped. Use `startFrom: '0'` or [replay](operations.md#replay).
4. Do both sides use the same `prefix` and the same Redis database? A different `prefix` is a different bus.
5. In NestJS, a module that lists several topics needs `topicName` on `@OnLaneEvent`, and a module needs a `consumerName` (or `defaultConsumerName` in `forRoot`). Startup errors name the class and method.
6. Look at the [dashboard](../dashboard/overview.md): the topic's events, and for one event where it stands for each consumer (`not-read`, `pending`, `retrying`, `dead-letter`, `done`).

## The lag keeps growing

Lag is how many events the consumer has not read yet.

- The consumer is not running, or crashed. Check `instances` in `bus.stats(...)`.
- It is slower than the emitters. Raise `concurrency` for handlers that wait on I/O, or run more instances of the consumer.
- One slow event blocks a handler: look at `pending` and the idle time of the instances (`bus.stats(topic, { instances: true })`).
- Trimming is dropping events it has not read: see below.

## Old events are gone

Topics keep about the latest 1 000 000 events by default; older ones are trimmed on `emit`. Set `retention` per topic (`maxLen`, `maxAgeMs`, or `false` to keep everything) and watch lag so a slow consumer does not fall behind the trim point. See [Retention](operations.md#retention).

## All events vanished after Redis restarted

Redis ran without persistence. Start it with `appendonly yes` and check the [Redis setup](operations.md#redis-setup). Running consumers recreate themselves after such a loss, but the lost events are gone.

## `emit` hangs, or fails when Redis is down

While Redis is unreachable the command waits in the client's queue and completes after the reconnect. If the outage outlasts the client's retry limit, `emit` rejects and the event is **not** stored. Handle that rejection; to keep a database change and its event consistent use an [outbox](patterns.md#outbox). Details: [When Redis is unavailable](reliability.md#when-redis-is-unavailable).

## My events arrive out of order

Order is kept only with one instance of the consumer, `concurrency: 1` and no failing handlers. A retried event runs after its backoff, so later events can overtake it. See [Ordering](reliability.md#ordering).

## An event ended up in the dead letters

It failed all its attempts, or it could not be decoded. Read the error and stack in the dashboard or with `bus.dlq.list(...)`, fix the cause, then retry it: `bus.dlq.retry(topic, id)` or `retryMany`. See the [recipe](recipes.md#find-out-why-something-failed-and-retry-it).

## Error: `NOGROUP`

The consumer's Redis state was deleted while it was running (for example `FLUSHALL`, or a restart without persistence). Running consumers notice and recreate it; you do not have to do anything, but events stored before the loss are gone.

## The dashboard shows nothing, or answers 403 or 429

- Empty: check that the board uses the same bus (same `prefix` and Redis) as your app.
- `403`: your `authorize` function returned `false`, or a write was attempted while the board is read-only (`readOnly` is the default).
- `429`: the rate limit (100 requests per 10 seconds per client by default) was hit; slow the polling interval in the page header.

## Still stuck

Open an issue on [GitHub](https://github.com/eventlane-dev/eventlane/issues) with the EventLane version, Node and Redis versions, and a small piece of code that shows the problem.
