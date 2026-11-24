---
layout: home

hero:
  name: EventLane
  text: A persistent event bus on Redis Streams
  tagline: Kafka-like topics and consumers with an EventEmitter-like API, for Node.js and NestJS. Use the Redis you already run for BullMQ.
  actions:
    - theme: brand
      text: Core (any Node.js app)
      link: /core/getting-started
    - theme: alt
      text: NestJS
      link: /nestjs/getting-started
    - theme: alt
      text: Dashboard
      link: /dashboard/overview

features:
  - title: Topics and consumers
    details: Emit to a topic; every consumer gets its own copy, and the instances of one consumer share the work.
    link: /core/concepts
    linkText: Concepts
  - title: Reliable by default
    details: At-least-once delivery with retry and backoff, dead letters, crash recovery, deduplication and idempotent emits.
    link: /core/reliability
    linkText: Reliability
  - title: Persistent and inspectable
    details: Events stay in Redis Streams. Read them, replay a consumer, trim by size or age, and look at lag and pending events.
    link: /core/operations
    linkText: Operations
  - title: NestJS integration
    details: A module, an injectable emitter and an @OnLaneEvent decorator. A module is a consumer.
    link: /nestjs/guide
    linkText: NestJS guide
  - title: Dashboard
    details: A Bull Board style web UI to browse events, watch consumers and inspect dead letters. Mounts into NestJS, Express or Fastify; read-only by default, with opt-in actions.
    link: /dashboard/getting-started
    linkText: Dashboard
  - title: Why not BullMQ or Kafka?
    details: BullMQ runs jobs, Kafka is heavy for a small system. EventLane fills the gap for business events on Redis.
    link: /comparison
    linkText: Comparison
---

## In a nutshell

```bash
npm install @eventlane/core ioredis
```

```ts
import { EventLaneBus } from '@eventlane/core';

const bus = new EventLaneBus({ redisUrl: process.env.REDIS_URL!, consumerName: 'notifications' });

bus.on('users', 'user.created', async (payload) => {
  await sendWelcomeMail(payload.email);   // throw to retry; it is acknowledged when this returns
});
await bus.start();

await bus.emit('users', 'user.created', { id: 1, email: 'ada@example.com' });
```

An `EventEmitter` is gone when the process restarts and cannot reach a second instance. With Redis in place, the same style of code gives you events that are stored, retried, shared between instances and visible in a [dashboard](/dashboard/overview). Start as a monolith; when you split a module into its own service, keep the topic and consumer names and nothing else changes ([how](/core/recipes#split-a-monolith-into-services-later)).

## How the documentation is organized

- **Core**: the framework-independent library and its concepts. Read this first, whatever framework you use.
- **NestJS**: the integration package, built on the core. Start with its getting started page.
- **Dashboard**: a web UI as separate packages that mounts into NestJS, Express or Fastify.
- **Project**: [how EventLane compares to alternatives](/comparison), the [changelog](/changelog) and a [briefing for AI coding agents](/for-agents).
