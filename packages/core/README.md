# @eventlane/core

A persistent event bus for Node.js on Redis Streams. Emit events to a topic; every consumer of the topic receives every event, several instances of one consumer share the work, and events survive restarts. Failed handlers are retried with backoff and end up in a dead-letter stream. You can inspect and replay history. A dashboard is available as separate packages.

## Install

```bash
npm install @eventlane/core ioredis
```

Needs Redis 6.2 or newer with persistence on (`appendonly yes`). For NestJS use [`@eventlane/nestjs`](https://www.npmjs.com/package/@eventlane/nestjs).

## Use it

```ts
import { EventLaneBus } from '@eventlane/core';

const bus = new EventLaneBus({ redisUrl: process.env.REDIS_URL!, consumerName: 'notifications' });

// listen: topic, event name, handler (throw to retry)
bus.on('users', 'user.created', async (payload, meta) => {
  console.log('welcome', payload.email);
});
await bus.start();

// emit from anywhere: this process or another service
await bus.emit('users', 'user.created', { id: 1, email: 'ada@example.com' });

// on shutdown
await bus.close();
```

## Good to know

- Delivery is **at-least-once**: make handlers idempotent, or pass `dedup: true`.
- Events are handled in order only with one instance, `concurrency: 1` and no failing handlers.
- A topic keeps about the latest 1 000 000 events by default; set `retention` to change it.
- No partitions, no Redis Cluster, no wildcard event names.

## Documentation

- [Getting started](https://eventlane-dev.github.io/eventlane/core/getting-started), [Concepts](https://eventlane-dev.github.io/eventlane/core/concepts), [Core API](https://eventlane-dev.github.io/eventlane/core/api)
- [Reliability](https://eventlane-dev.github.io/eventlane/core/reliability), [Operations](https://eventlane-dev.github.io/eventlane/core/operations), [Production checklist](https://eventlane-dev.github.io/eventlane/core/production-checklist)

## License

MIT. Source and issues: [github.com/eventlane-dev/eventlane](https://github.com/eventlane-dev/eventlane).
