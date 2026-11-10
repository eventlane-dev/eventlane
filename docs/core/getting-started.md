# Getting started with the core

> Uses `@eventlane/core`, which works in any Node.js app (Express, Fastify, workers, scripts). On NestJS, start with the [NestJS getting started](../nestjs/getting-started.md) instead.

## Requirements

- Node.js 20+ (runtime). Developing this repository needs Node 22.18+ because of the build and test tooling.
- Redis **6.2 or newer** (needed for `XAUTOCLAIM`). Redis 7+ gives more accurate consumer lag in [stats](operations.md#stats-and-lag).
- `ioredis` installed in your project (a peer dependency, the same client BullMQ uses).

Start a local Redis:

```bash
docker run --rm --name my-redis -p 6379:6379 redis:7 redis-server --appendonly yes
```

`--appendonly yes` matters: without persistence, events are lost when Redis restarts. See [Operations](operations.md#redis-setup).

New to the vocabulary? [Concepts](concepts.md) explains `topicName`, `eventName`, `consumerName` and `instanceName` in two minutes.

## Plain Node.js (Express, scripts, workers)

```bash
npm install @eventlane/core ioredis
```

```ts
import { EventLaneBus } from '@eventlane/core';

const bus = new EventLaneBus({
  redisUrl: process.env.REDIS_URL!,   // or redis: { host, port, password, db } / an ioredis client
  consumerName: 'notifications',      // this process is the "notifications" consumer
});

// 1. listen: topicName, eventName, handler
bus.on('users', 'user.created', async (payload, meta) => {
  console.log('new user', payload.email, 'from topic', meta.topicName);
});

await bus.start();

// 2. emit from anywhere (same process or another one)
await bus.emit('users', 'user.created', { id: 1, email: 'a@b.com' });

// 3. shut down gracefully
process.on('SIGTERM', () => bus.close());
```

Next: [Concepts](concepts.md) for how the pieces behave together, then the [Core API](api.md). Before going live, read the [Production checklist](production-checklist.md); [Patterns](patterns.md) covers outbox, metrics and testing.
