# For AI coding agents

A short, accurate briefing for AI assistants that write code with EventLane. The whole documentation as plain text is at [`llms-full.txt`](https://eventlane-dev.github.io/eventlane/llms-full.txt), and an index of the pages is at [`llms.txt`](https://eventlane-dev.github.io/eventlane/llms.txt).

## What it is

EventLane is a persistent event bus on Redis for Node.js and NestJS. Services emit events to a **topic**; every **consumer** of the topic receives every event; several instances of one consumer share the work. Events survive restarts and are retried, dead-lettered and replayable. It is not Kafka: no partitions, no Redis Cluster.

## Install

```bash
npm install @eventlane/core ioredis                      # any Node.js app
npm install @eventlane/nestjs @eventlane/core ioredis    # NestJS
npm install @eventlane/board-nestjs @eventlane/board-express @eventlane/nestjs @eventlane/core  # NestJS dashboard
```

Needs Redis 6.2 or newer with persistence on (`appendonly yes`) and `maxmemory-policy noeviction`. `ioredis` is a peer dependency.

## Vocabulary

| Term | Meaning |
|---|---|
| `topicName` | A channel of related events, for example `users`. |
| `eventName` | The kind of event inside a topic, for example `user.created`. |
| `consumerName` | A logical receiver, for example `notifications`. In NestJS a module is one consumer. |
| `instanceName` | One running process of a consumer. Generated; never set it by hand. |
| payload | The JSON data of an event. A handler is `(payload, meta)`. |

## Minimal correct code

```ts
import { EventLaneBus } from '@eventlane/core';

const bus = new EventLaneBus({ redisUrl: process.env.REDIS_URL!, consumerName: 'notifications' });

bus.on('users', 'user.created', async (payload, meta) => {
  // throw to retry; return normally to acknowledge
});
await bus.start();

await bus.emit('users', 'user.created', { id: 1 }, { idempotencyKey: 'user-1', headers: { correlationId: 'abc' } });
process.on('SIGTERM', () => bus.close());
```

NestJS:

```ts
// app.module.ts
EventLaneModule.forRoot({ redisUrl: process.env.REDIS_URL })

// a module that only emits
EventLaneModule.forFeature({ topicNames: ['users'] })
constructor(@InjectLaneEmitter('users') private readonly users: TopicEmitter) {}
await this.users.emit('user.created', { id: 1 });

// a module that is a consumer
EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users'] })
@OnLaneEvent('user.created')
async welcome(payload: { id: number }, meta: EventMetadata) {}
```

## Rules to follow

- Delivery is **at-least-once**: handlers must be idempotent (or use `dedup: true`). An event is acknowledged only after the handler returns.
- A handler that throws is retried with backoff and then moved to the dead-letter stream. Do not catch and swallow errors you want retried.
- Order is guaranteed only with one instance, `concurrency: 1` and no failing handlers. Do not assume more.
- Pass `idempotencyKey` to `emit` when the caller may retry. To keep a database change and its event consistent use an [outbox](core/patterns.md#outbox).
- Retries go only to the consumer that failed. Do not re-emit an event to retry it.
- In NestJS, pass `topicName` to `@OnLaneEvent` when the module lists several topics.
- Topics keep about the latest 1 000 000 events by default; set `retention` per topic otherwise.
- Do not invent features: there are no wildcard event names, no schema validation, no typed event maps and no Redis Cluster support.

## Where to look

- [Core API](core/api.md) and [configuration](core/configuration.md) for every option.
- [Reliability](core/reliability.md) for retries, dead letters and ordering.
- [NestJS guide](nestjs/guide.md) for modules and decorators.
- [Production checklist](core/production-checklist.md) before running real traffic.
- [Dashboard](dashboard/overview.md): mount it only behind authentication.
