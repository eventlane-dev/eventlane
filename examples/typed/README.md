# Example: typed events

The same events, described once in [`src/events.ts`](src/events.ts), checked everywhere at compile time: topic names, event names and payloads. Typing is optional and changes nothing at runtime.

| File | What it shows |
|---|---|
| [`src/events.ts`](src/events.ts) | `UserEvents`, `OrderEvents` (`eventName` to payload) and `AppEvents` (`topicName` to its events). |
| [`src/users.module.ts`](src/users.module.ts) | `@InjectLaneEmitter('users') users: TopicEmitter<UserEvents>`: an emitter typed per topic. |
| [`src/orders.module.ts`](src/orders.module.ts) | `EventLaneEmitter<AppEvents>`: the general emitter, where the topic is an argument and is checked too. |
| [`src/notifications.module.ts`](src/notifications.module.ts) | `@OnLaneEvent<UserEvents>('user.registered', { topicName: 'users' })`: a consumer of two topics, each handler checked against its topic. |
| [`src/audit.module.ts`](src/audit.module.ts) | A handler for every event of a topic: the payload is the union of the payload types. |
| [`src/plain.ts`](src/plain.ts) | The same typing in plain Node.js: `new EventLaneBus<AppEvents>(...)`. |

The lines that are commented out as `error: ...` are mistakes the compiler rejects; uncomment one to see it.

## Run

Needs Redis (`pnpm redis:up` at the repository root, on `localhost:6390`) and the built packages (`pnpm build`), both from the repository root.

```bash
pnpm --filter @eventlane/example-typed start         # the NestJS app
pnpm --filter @eventlane/example-typed start:plain   # the plain Node.js script
pnpm --filter @eventlane/example-typed typecheck     # the compiler's view
```

Expected output of the NestJS app:

```
[main] user 1762725960000 placed an order (event 1762725960001-0)
[notifications] welcome mail to ada@example.com (attempt 1)
[notifications] order 1762725960000 confirmed, total 99
[audit] order.placed {"orderId":1762725960000,"userId":1762725960000,"total":99}
[audit] order.cancelled {"orderId":1762725960000,"reason":"changed my mind"}
```

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6390` | The Redis to use. |

Documentation: [typed events in the core](https://eventlane-dev.github.io/eventlane/core/typed-events) and [in NestJS](https://eventlane-dev.github.io/eventlane/nestjs/typed-events).
