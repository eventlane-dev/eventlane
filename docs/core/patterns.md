# Patterns

Recipes for situations that come up when you run EventLane in a real application. They use only the public API.

## Outbox: keep a database change and its event consistent {#outbox}

Saving to your database and emitting to Redis are two separate writes. If the process dies between them, or `emit` fails, you get a saved row with no event (or an event for a row that was rolled back). EventLane cannot make both writes atomic, because they live in different systems.

The usual fix is an **outbox table**: write the event into your database in the same transaction as the change, and let a small relay move it to EventLane afterwards.

```ts
// 1. In the transaction: the change and the outbox row commit together
await db.transaction(async (tx) => {
  const order = await tx.orders.insert(data);
  await tx.outbox.insert({
    id: `order-placed-${order.id}`,
    topicName: 'orders',
    eventName: 'order.placed',
    payload: order,
  });
});

// 2. A relay (a loop or a cron job) publishes rows that are not sent yet
async function relay() {
  for (const row of await db.outbox.findUnsent({ limit: 100 })) {
    await bus.emit(row.topicName, row.eventName, row.payload, {
      idempotencyKey: row.id, // a crash between emit and the update below cannot create a duplicate
    });
    await db.outbox.markSent(row.id);
  }
}
```

The `idempotencyKey` makes the relay safe to repeat: emitting the same key again returns the original event id and stores nothing (for `dedupTtlSeconds`, 24 hours by default). The result is at-least-once from the database to the topic, and [at-least-once](reliability.md) from the topic to the handlers, so handlers should still be idempotent or use `dedup`.

Use it when losing an event is worse than delaying it (payments, orders). For notifications where an occasional miss is acceptable, emitting right after the commit and logging a failure is simpler.

If `emit` fails (Redis down longer than the client retries, see [When Redis is unavailable](reliability.md#when-redis-is-unavailable)), nothing is stored and nothing is retried for you. With an outbox that is fine: the row stays unsent and the next relay run tries again.

## Metrics {#metrics}

`bus.stats(topicName)` gives length, dead letters and, per consumer, lag, pending and retrying events (see [Stats and lag](operations.md#stats-and-lag)). EventLane ships no metrics package; expose these numbers as gauges and alert on them.

### Prometheus (`prom-client`)

```ts
import { Gauge, register } from 'prom-client';

const topicNames = ['users', 'orders'];

new Gauge({
  name: 'eventlane_topic_length',
  help: 'Events stored in the topic',
  labelNames: ['topic'],
  async collect() {
    for (const topicName of topicNames) {
      this.set({ topic: topicName }, (await bus.stats(topicName)).length);
    }
  },
});

new Gauge({
  name: 'eventlane_dead_letters',
  help: 'Events in the dead-letter stream of the topic',
  labelNames: ['topic'],
  async collect() {
    for (const topicName of topicNames) {
      this.set({ topic: topicName }, (await bus.stats(topicName)).deadLetters);
    }
  },
});

for (const field of ['lag', 'pending', 'retrying'] as const) {
  new Gauge({
    name: `eventlane_consumer_${field}`,
    help: `Consumer ${field} (events)`,
    labelNames: ['topic', 'consumer'],
    async collect() {
      for (const topicName of topicNames) {
        for (const c of (await bus.stats(topicName)).consumers) {
          this.set({ topic: topicName, consumer: c.consumerName }, c[field]);
        }
      }
    },
  });
}

// in your HTTP server: respond to GET /metrics with
//   await register.metrics()
```

`collect` runs only when Prometheus scrapes, so the cost is one `stats` call per topic per scrape. Reading the topics from `await bus.topics()` instead of a fixed list also works.

### OpenTelemetry

Use the same calls inside the callback of an observable gauge:

```ts
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('eventlane');
const lag = meter.createObservableGauge('eventlane.consumer.lag');
lag.addCallback(async (result) => {
  for (const topicName of await bus.topics()) {
    for (const c of (await bus.stats(topicName)).consumers) {
      result.observe(c.lag, { topic: topicName, consumer: c.consumerName });
    }
  }
});
```

### What to alert on

| Signal | Meaning |
|---|---|
| `lag` keeps growing | The consumer is slower than the emitters, or it is down. |
| `pending` stays high | Handlers are stuck or slow; events are delivered but not acknowledged. |
| `deadLetters` grows | Events exhausted their retries; inspect them in the [dashboard](../dashboard/overview.md) or with `bus.dlq`. |
| `lag` close to the topic `length` | The consumer may lose events to [retention](operations.md#retention). |

## Health check

A readiness probe only needs to know that Redis answers:

```ts
app.get('/health', async (_req, res) => {
  try {
    await bus.topics(); // one SCAN: proves the connection works
    res.sendStatus(200);
  } catch {
    res.sendStatus(503);
  }
});
```

Keep the check cheap: do not run `stats` on every probe.

## Testing handlers

Handlers are ordinary functions, so test the logic by calling them directly with a payload and a fake `meta`. To test the whole path (emit, delivery, retry) run a real Redis, as EventLane's own tests do, and give each test its own `prefix` so tests cannot see each other's events:

```ts
const bus = new EventLaneBus({
  redisUrl: process.env.REDIS_URL,
  consumerName: 'notifications',
  prefix: `test-${crypto.randomUUID()}`,
  blockTimeMs: 100,
  retry: { attempts: 3, backoff: { type: 'fixed', delay: 20 } },
});
```

Close the bus (`await bus.close()`) at the end of each test.
