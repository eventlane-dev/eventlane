# Getting started with NestJS

> Uses `@eventlane/nestjs` (and `@eventlane/core` underneath). A runnable monolith is in `examples/nestjs` in the repository.

## Requirements

- NestJS 10, 11 or 12, and Node.js 20+.
- Redis **6.2 or newer**, with persistence on. See [Redis setup](../core/operations.md#redis-setup).
- `ioredis` installed in your project (a peer dependency, the same client BullMQ uses).

```bash
docker run --rm --name my-redis -p 6379:6379 redis:7 redis-server --appendonly yes
```

New to the vocabulary? [Concepts](../core/concepts.md) explains `topicName`, `eventName`, `consumerName` and `instanceName` in two minutes.

## Install

```bash
npm install @eventlane/nestjs @eventlane/core ioredis
```

## Set up the modules

```ts
// app.module.ts
@Module({
  imports: [
    EventLaneModule.forRoot({ redisUrl: process.env.REDIS_URL, defaultConsumerName: 'my-app' }),
    UsersModule,
    NotificationsModule,
  ],
})
export class AppModule {}

// users.module.ts: this module emits to the "users" topic
@Module({
  imports: [EventLaneModule.forFeature({ topicNames: ['users'] })],
  providers: [UsersService],
})
export class UsersModule {}

// notifications.module.ts: this module is the "notifications" consumer
@Module({
  imports: [EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users'] })],
  providers: [NotificationsHandler],
})
export class NotificationsModule {}
```

## Emit and handle

```ts
@Injectable()
export class UsersService {
  constructor(@InjectLaneEmitter('users') private readonly users: TopicEmitter) {}

  create() {
    return this.users.emit('user.created', { id: 1, email: 'a@b.com' });
  }
}

@Injectable()
export class NotificationsHandler {
  @OnLaneEvent('user.created')
  async welcome(payload: { id: number; email: string }) {
    // sends an email; retried automatically on failure
  }
}
```

Call `app.enableShutdownHooks()` in `main.ts` so in-flight handlers finish before the process exits.

## Next

- [Module, emitters and handlers](guide.md): everything about `forRoot`, `forFeature`, `EventLaneEmitter` and `@OnLaneEvent`.
- [NestJS configuration](configuration.md): the options of the module and the decorators.
- [Concepts](../core/concepts.md) and [Reliability](../core/reliability.md): what retries, dead letters and consumers mean.
