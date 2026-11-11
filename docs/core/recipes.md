# Recipes

Short answers to "how do I...". Each recipe uses only the public API. Names are explained in [Concepts](concepts.md).

## Send an email after a user registers

Emit where the event happens, handle it in the consumer that sends mail. The registration code does not know about mail.

```ts
// where the user is created
await bus.emit('users', 'user.registered', { id: user.id, email: user.email });

// in the mail service (its own consumerName)
bus.on('users', 'user.registered', async ({ email }) => {
  await mailer.sendWelcome(email); // throw to retry; the user is not affected
});
```

If saving the user and emitting the event must not get out of step, use an [outbox](patterns.md#outbox).

## Let several services react to one event

Give each service its own `consumerName`. Every consumer receives every event.

```ts
// billing service
const billing = new EventLaneBus({ redisUrl, consumerName: 'billing' });
billing.on('orders', 'order.placed', chargeCard);

// shipping service
const shipping = new EventLaneBus({ redisUrl, consumerName: 'shipping' });
shipping.on('orders', 'order.placed', createShipment);
```

Running three copies of the billing service does not charge three times: the instances of one consumer share the work.

## Split a monolith into services later

Keep the topic names and consumer names. Move a handler into a new process that uses the same `consumerName` and the same Redis: it continues from where the old one stopped, with no events lost. Stop the old handler after the new one runs.

## Handle a slow or unreliable external API

Retries with backoff are on by default (5 attempts). Tune them per subscription, and raise `concurrency` for handlers that wait on I/O:

```ts
bus.on('orders', 'order.placed', callPaymentProvider, {
  concurrency: 10,
  retry: { attempts: 6, backoff: { type: 'exponential', delay: 2000, maxDelay: 60000 } },
});
```

More concurrency gives up [ordering](reliability.md#ordering).

## Make a handler safe to run twice

Delivery is at-least-once, so a handler can run twice for one event. Either make the work idempotent (an upsert, a unique key) or let EventLane skip events this consumer already finished:

```ts
bus.on('orders', 'order.placed', createInvoice, { dedup: true });
```

Pass `idempotencyKey` to `emit` when the caller itself may retry. See [Deduplication](reliability.md#deduplication).

## Find out why something failed and retry it

Events that fail all their attempts go to the dead-letter stream with the error and stack:

```ts
const failed = await bus.dlq.list('orders', { consumerName: 'billing', count: 20 });
console.log(failed[0].error, failed[0].stack);

await bus.dlq.retry('orders', failed[0].id);                          // one event
await bus.dlq.retryMany('orders', { consumerName: 'billing' });       // everything that billing failed
```

The [dashboard](../dashboard/overview.md) does the same with buttons.

## Reprocess history after a bug

To run a consumer over old events again, move its position back:

```ts
await bus.replay('orders', { consumerName: 'reporting', from: new Date('2026-11-01') });
```

For a clean run that ignores earlier "already done" markers, create a **new** consumer instead (`consumerName: 'reporting-v2'` with `startFrom: '0'`). See [Replay](operations.md#replay).

## Add a new consumer that also needs the old events

A consumer that does not exist yet starts at "now" by default. To start from the beginning of the topic:

```ts
bus.on('users', 'user.created', backfill, { consumerName: 'analytics', startFrom: '0' });
```

It only reads what the [retention](operations.md#retention) still keeps.

## Listen to every event of a topic

Leave out the event name:

```ts
bus.on('orders', async (payload, meta) => {
  audit.write(meta.eventName, payload);
});
```

## Follow one request across services

Put an id in `headers` when you emit and read it in the handler:

```ts
await bus.emit('orders', 'order.placed', order, { headers: { correlationId: req.id } });

bus.on('orders', 'order.placed', async (order, meta) => {
  logger.info({ correlationId: meta.headers.correlationId }, 'charging');
});
```

## Shut down without losing work

Call `await bus.close()` on `SIGTERM`. It stops reading, waits for handlers in progress and leaves unfinished events for another instance to pick up. In NestJS call `app.enableShutdownHooks()`.
