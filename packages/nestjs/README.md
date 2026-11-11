# @eventlane/nestjs

NestJS integration for [EventLane](https://www.npmjs.com/package/@eventlane/core), a persistent event bus on Redis Streams: a module, `@OnLaneEvent` handlers and injectable emitters. Each module can be an independent consumer of a topic, with retries, dead letters and replay.

## Install

```bash
npm install @eventlane/nestjs @eventlane/core ioredis
```

Works with NestJS 10, 11 and 12. Needs Redis 6.2 or newer with persistence on.

## Use it

```ts
// app.module.ts
EventLaneModule.forRoot({ redisUrl: process.env.REDIS_URL })

// users.module.ts: emits to the "users" topic
EventLaneModule.forFeature({ topicNames: ['users'] })

// notifications.module.ts: this module is the "notifications" consumer
EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users'] })
```

```ts
@Injectable()
export class UsersService {
  constructor(@InjectLaneEmitter('users') private readonly users: TopicEmitter) {}

  create() {
    return this.users.emit('user.created', { id: 1, email: 'ada@example.com' });
  }
}

@Injectable()
export class NotificationsHandler {
  @OnLaneEvent('user.created')
  async welcome(payload: { id: number; email: string }) {
    // retried automatically when it throws
  }
}
```

Call `app.enableShutdownHooks()` so in-flight handlers finish before the process exits. Delivery is at-least-once, so keep handlers idempotent.

## Documentation

- [Getting started](https://eventlane-dev.github.io/eventlane/nestjs/getting-started), [Module, emitters and handlers](https://eventlane-dev.github.io/eventlane/nestjs/guide), [Configuration](https://eventlane-dev.github.io/eventlane/nestjs/configuration)
- [Reliability](https://eventlane-dev.github.io/eventlane/core/reliability), [Production checklist](https://eventlane-dev.github.io/eventlane/core/production-checklist)

## License

MIT. Source and issues: [github.com/eventlane-dev/eventlane](https://github.com/eventlane-dev/eventlane).
