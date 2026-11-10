# Dashboard

A web dashboard for EventLane, in the spirit of Bull Board: a separate package you mount into your own app to **look at the events and consumers living in Redis**, find out why something is stuck, and fix it without opening `redis-cli`.

It is a separate package on purpose. The core and the NestJS package never serve HTTP or a UI; the dashboard sits on top of the same public API (`read`, `stats`, `dlq`, `replay`, ...) that your own code can use.

> [!WARNING]
> The dashboard has no login of its own. Protect it before exposing it: [Security notes](getting-started.md#security-notes).

## What you can do

- **See every topic** with its size, number of consumers, total lag, pending, retrying and dead-letter counts, at a glance.
- **Browse the events of a topic**: newest first, filtered by event name or time range, with the payload, headers, id and timestamp.
- **Understand each consumer**: instances attached, how far behind it is (lag), which events are pending on which instance and for how long, which events are waiting for a retry and when.
- **Handle dead letters**: see the error and stack, retry one, selected or all events, or purge them.
- **Replay history** for a consumer from the beginning, a time, or an event id; remove an obsolete consumer.
- **Stay safe**: read-only mode, your own authorization hook, and payload redaction.

## Sketch

```
 Topics                                                   [ refresh: 5s ]
 ─────────────────────────────────────────────────────────────────────────
  topic      events   consumers   lag    pending   retrying   dead letters
  users      12 840   2            0      2         1          0
  orders     4 120    3            5 120  0         0          14      ▸

 orders ▸  [ Events ]  Consumers   Retrying   Dead letters (14)
 ─────────────────────────────────────────────────────────────────────────
  filter: eventName [ order.placed ▾ ]   from [ …  ]   to [ …  ]
  1762725960000-0   order.placed   {"orderId":42,"total":99}      2026-11-10 14:02
  1762725959000-0   order.placed   {"orderId":41,"total":12}      2026-11-10 14:02
```

## How you will use it

The board mounts into your server through an adapter (Express, Fastify, NestJS).

```ts
// Express
// read-only unless you pass readOnly: false
app.use('/admin/events', createBoard({ buses: [bus] }).router);

// Fastify
app.register(createBoard({ buses: bus }).plugin, { prefix: '/admin/events' });

// NestJS: finds the EventLaneBus of EventLaneModule by itself
BoardModule.forRoot({ route: '/admin/events', readOnly: false, authorize: (req) => req.user?.isAdmin });
```

Continue with [Getting started](getting-started.md).
