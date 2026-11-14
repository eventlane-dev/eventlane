# Dashboard

A web dashboard for EventLane, in the spirit of Bull Board: a separate package you mount into your own app to **look at the events and consumers living in Redis**, find out why something is stuck, and fix it without opening `redis-cli`.

![The EventLane dashboard listing the events of a topic](/dashboard.jpg)

It is a separate package on purpose. The core and the NestJS package never serve HTTP or a UI; the dashboard sits on top of the same public API (`read`, `stats`, `dlq`, `replay`, ...) that your own code can use.

> [!WARNING]
> The dashboard has no login of its own. Protect it before exposing it: [Security notes](options.md#security-notes).

## What you can do

- **See every topic** with its size, number of consumers, total lag, pending, retrying and dead-letter counts, at a glance.
- **Browse the events of a topic**: newest first, filtered by event name or time range, with the payload, headers, id and timestamp.
- **Understand each consumer**: instances attached, how far behind it is (lag), which events are pending on which instance and for how long, which events are waiting for a retry and when.
- **Handle dead letters**: see the error and stack, retry one, selected or all events, or purge them.
- **Replay history** for a consumer from the beginning, a time, or an event id; remove an obsolete consumer.
- **Stay safe**: read-only mode, your own authorization hook, and payload redaction.

## Mount it

The board mounts into your server through an adapter (Express, Fastify or NestJS) and is read-only unless you ask otherwise:

```ts
app.use('/admin/events', createBoard({ buses: [bus] }).router);   // Express
```

[Getting started](getting-started.md) has the setup for each framework, [Using the board](using.md) describes the screens, and [Options and security](options.md) the settings.
