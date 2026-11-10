# NestJS guide: module, emitters and handlers

Requires `@nestjs/common` and `@nestjs/core` 10, 11 or 12. A runnable monolith lives in `examples/nestjs` in the repository.

The Nest package wraps `@eventlane/core` in a dynamic module with decorators and dependency injection. Terms: [`topicName`, `eventName`, `consumerName`, `instanceName`](../core/concepts.md).

## Registering the module

### `forRoot` / `forRootAsync`

Once, in `AppModule`. Holds the Redis connection and global defaults. Provide **either** `redisUrl` **or** `redis` (connection object or ioredis client), as in [core](../core/api.md#creating-a-bus).

```ts
EventLaneModule.forRoot({
  redisUrl: process.env.REDIS_URL,              // or: redis: { host, port, password, db, tls }
  defaultConsumerName: 'my-app',                // used by modules that do not set their own
  topics: {                                     // optional per-topic configuration, keyed by topicName
    orders: { retention: { maxLen: 50_000 } },
  },
});

EventLaneModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    redis: {
      host: config.getOrThrow('REDIS_HOST'),
      port: config.get('REDIS_PORT', 6379),
      password: config.get('REDIS_PASSWORD'),
    },
    defaultConsumerName: 'my-app',
  }),
});
```

`forRoot` is global: do not import it again elsewhere, only `forFeature`.

### `forFeature`

In every module that emits or listens.

```ts
EventLaneModule.forFeature({
  consumerName: 'notifications',      // this module is the consumer "notifications"
  topicNames: ['users', 'orders'],    // topics it emits to and/or listens to
});
```

- `topicNames` makes `@InjectLaneEmitter(topicName)` available in this module (the emitter providers are created and exported by `forFeature`) and sets the default topic for `@OnLaneEvent`.
- `consumerName` makes this module a consumer. Omit it for a module that only emits (or that should use `defaultConsumerName`).
- Every `@OnLaneEvent` handler provided in the module belongs to the module's consumer.
- A module can import `forFeature` several times (for example to split topics), but it is a single consumer: two different `consumerName`s in one module fail at startup.

## Emitting

There are two ways to emit. Both work in any provider.

### 1. Topic-bound: `@InjectLaneEmitter(topicName)`

```ts
@Injectable()
export class UsersService {
  constructor(@InjectLaneEmitter('users') private readonly users: TopicEmitter) {}

  async create(dto: CreateUserDto) {
    const user = await this.repo.save(dto);
    await this.users.emit('user.created', user);   // topicName is pre-bound
    return user;
  }
}
```

The argument of `@InjectLaneEmitter` is a `topicName`, and the injected `TopicEmitter` only needs `emit(eventName, payload)`. A service can inject several:

```ts
constructor(
  @InjectLaneEmitter('users') private readonly users: TopicEmitter,
  @InjectLaneEmitter('orders') private readonly orders: TopicEmitter,
) {}
```

### 2. General: plain `EventLaneEmitter`

Inject the class itself, with no decorator, and pass the topic on every call:

```ts
@Injectable()
export class UsersService {
  constructor(private readonly emitter: EventLaneEmitter) {}

  async create(dto: CreateUserDto) {
    const user = await this.repo.save(dto);
    await this.emitter.emit('users', 'user.created', user);   // topicName, eventName, payload
    return user;
  }
}
```

Use it when the topic is dynamic or a service emits to many topics. It also offers `emitter.topic('orders')`, which returns a `TopicEmitter` bound to that topic.

| Injection | Type | `emit` signature |
|---|---|---|
| `@InjectLaneEmitter('users') x: TopicEmitter` | `TopicEmitter` | `emit(eventName, payload, options?)` |
| `x: EventLaneEmitter` | `EventLaneEmitter` | `emit(topicName, eventName, payload, options?)` |

`EventLaneEmitter` comes from `forRoot` (which is global), so it needs no `forFeature`. `@InjectLaneEmitter(topicName)` does: the module must list the topic in `forFeature({ topicNames })`, otherwise Nest reports that it cannot resolve the dependency.

To reach the underlying bus (for `stats()`, `dlq`, `replay`, `read` and the other [operations](../core/operations.md)), use `@InjectEventLaneBus() bus: EventLaneBus`.

## Listening: `@OnLaneEvent`

```ts
@Injectable()
export class NotificationsHandler {
  // topicName taken from the module's forFeature (it lists exactly one topic)
  @OnLaneEvent('user.created')
  async welcome(payload: { id: number; email: string }, meta: EventMetadata) {}

  // explicit topicName: required when the module lists several topics
  @OnLaneEvent('order.placed', { topicName: 'orders' })
  async confirm(payload: any) {}

  // every event of a topic
  @OnLaneEvent({ topicName: 'orders' })
  async audit(payload: any, meta: EventMetadata) {}

  // options
  @OnLaneEvent('user.created', { concurrency: 5, dedup: true })
  async index(payload: any) {}
}
```

Signature: `@OnLaneEvent(eventName?: string, options?: { topicName?, consumerName?, concurrency?, dedup?, retry?, startFrom? })`. Handlers receive `(payload, meta)`. The decorator can be stacked on one method to listen to several event names. The options (except `topicName`) are the subscription options of the core (see [NestJS configuration](configuration.md)).

Rules:
- `topicName` resolves from `options.topicName`, otherwise from the module's `forFeature` when it lists exactly one topic, otherwise startup fails with a clear error.
- `consumerName` resolves from `options.consumerName`, otherwise from the module's `forFeature`, otherwise from `forRoot.defaultConsumerName`.
- Handlers are discovered at application bootstrap (`onApplicationBootstrap`), and reading starts after every module has initialized. A problem (unresolvable topic or consumer, conflicting consumers, a handler on a request-scoped or transient provider) fails the bootstrap with a message naming the `Class.method`.
- Handlers must live in singleton providers (or controllers). They run with the provider as `this`, so injected dependencies work.

## Monolith example: two consumers on one topic

```ts
@Module({
  imports: [EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users'] })],
  providers: [NotificationsHandler],
})
export class NotificationsModule {}

@Module({
  imports: [EventLaneModule.forFeature({ consumerName: 'webhooks', topicNames: ['users'] })],
  providers: [WebhooksHandler],
})
export class WebhooksModule {}
```

`user.created` is handled once by `notifications` and once by `webhooks`. If the app runs as three instances, each consumer still handles the event exactly once across those instances.

## Lifecycle

- Subscribes the handlers and starts reading in `onApplicationBootstrap`. Emitting works earlier (for example in `onModuleInit`).
- Stops in `onApplicationShutdown` (call `app.enableShutdownHooks()`, or `app.close()` in tests): in-flight handlers finish (up to `shutdownTimeoutMs`), then the connections close. If bootstrap fails, the bus is closed before the error is rethrown.

## Dashboard

`@eventlane/board-nestjs` adds a web UI to a Nest app: `BoardModule.forRoot({ route: '/admin/events' })` shows the bus of `EventLaneModule`. See the [dashboard docs](../dashboard/getting-started.md#nestjs).

## Testing your code

Inject a fake `EventLaneEmitter` or `TopicEmitter` in unit tests, or run integration tests against a real Redis. See [Testing handlers](../core/patterns.md#testing-handlers).
