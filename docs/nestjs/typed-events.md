# Typed events in NestJS

Describe the events of a topic once and the compiler checks the emitters and the handlers: event names, payloads and (for the general emitter) topic names. Typing is **optional** and compile-time only; nothing changes at runtime and nothing validates incoming data. The core side is explained in [Typed events](../core/typed-events.md); this page shows the NestJS parts.

A runnable app is in [`examples/typed`](https://github.com/eventlane-dev/eventlane/tree/main/examples/typed).

## 1. Describe the events

One interface per topic, `eventName` to payload type. Keep it next to the module that owns the topic, or in a shared package if several services use it.

```ts
// users/user.events.ts
export interface UserEvents {
  'user.created': { id: number; email: string };
  'user.deleted': { id: number };
}

// orders/order.events.ts
export interface OrderEvents {
  'order.placed': { orderId: number; userId: number; total: number };
  'order.cancelled': { orderId: number; reason: string };
}

// only if you want the general emitter or the bus typed: the whole app
export interface AppEvents {
  users: UserEvents;
  orders: OrderEvents;
}
```

## 2. Emit

### Per topic: `TopicEmitter<UserEvents>`

`@InjectLaneEmitter('users')` chooses the topic; the type comes from the parameter.

```ts
@Injectable()
export class UsersService {
  constructor(@InjectLaneEmitter('users') private readonly users: TopicEmitter<UserEvents>) {}

  async create(dto: CreateUserDto) {
    const user = await this.repo.save(dto);
    await this.users.emit('user.created', { id: user.id, email: user.email });   // checked

    // await this.users.emit('user.created', { id: user.id });    // error: email is missing
    // await this.users.emit('user.creatd', user);                // error: unknown event name
    return user;
  }
}
```

This needs nothing but the type argument: no map for the whole app, no change to `forFeature`.

### General: `EventLaneEmitter<AppEvents>`

Here the topic is an argument, so it is checked as well. It needs no `forFeature`.

```ts
@Injectable()
export class OrdersService {
  constructor(private readonly emitter: EventLaneEmitter<AppEvents>) {}

  place(order: Order) {
    return this.emitter.emit('orders', 'order.placed', {
      orderId: order.id, userId: order.userId, total: order.total,
    });
    // this.emitter.emit('orders', 'user.deleted', { id: 1 });   // error: not an event of "orders"
  }
}
```

`emitter.topic('orders')` returns a `TopicEmitter<OrderEvents>`. Nest finds the emitter by its class, so the type argument changes nothing for dependency injection. If your build does not emit decorator metadata (for example tsx or esbuild), inject it explicitly: `@Inject(EventLaneEmitter)`.

### The bus: `EventLaneBus<AppEvents>`

```ts
constructor(@InjectEventLaneBus() private readonly bus: EventLaneBus<AppEvents>) {}
```

It gives you the typed `emit` and `on` of the core, besides the inspection methods.

## 3. Handle

Pass the events of the topic as the type argument of `@OnLaneEvent`:

```ts
@Injectable()
export class NotificationsHandler {
  @OnLaneEvent<UserEvents>('user.created')            // the event name is checked and autocompleted
  async welcome(payload: UserEvents['user.created'], meta: EventMetadata) {
    payload.email;                                    // string
  }

  // @OnLaneEvent<UserEvents>('user.creatd')          // error: unknown event name
}
```

### A module with several topics

`topicName` is still how a handler says which topic it listens to (see the [guide](guide.md#listening-onlaneevent)); the type argument is the events of that topic:

```ts
@Module({
  imports: [EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users', 'orders'] })],
  providers: [NotificationsHandler],
})
export class NotificationsModule {}

@Injectable()
export class NotificationsHandler {
  @OnLaneEvent<UserEvents>('user.created', { topicName: 'users' })
  async welcome(user: UserEvents['user.created']) {}

  @OnLaneEvent<OrderEvents>('order.placed', { topicName: 'orders' })
  async confirm(order: OrderEvents['order.placed']) {}
}
```

### Every event of a topic

Leave out the event name: the payload is the union of the payload types and `meta.eventName` tells them apart.

```ts
@OnLaneEvent<OrderEvents>({ topicName: 'orders' })
async audit(payload: OrderEvents[keyof OrderEvents], meta: EventMetadata) {
  console.log(meta.eventName, payload);
}
```

### How strict is the handler check?

The decorator checks that the event name exists in the interface and that the method takes the payload of one of its events (and optionally `meta`). It does **not** link the name to its own payload, because the compiler cannot infer the name when you pass the interface by hand: a method decorated for `'user.deleted'` that takes the payload of `'user.created'` is accepted. The emitters are checked exactly; for handlers, annotate the parameter with `UserEvents['user.deleted']` as above and the compiler holds you to the interface.

## Adopt it step by step

Every part is independent. Type one emitter, one handler or one topic and leave the rest: untyped `TopicEmitter`, `EventLaneEmitter`, `EventLaneBus` and `@OnLaneEvent('user.created')` keep working as before.

## What it does not do

- **No runtime validation.** The data in Redis can be older than your types or come from a service you do not control. Validate in the handler when that matters; a thrown error is [retried and then dead-lettered](../core/reliability.md#retries-and-backoff).
- **Inspection stays untyped.** `bus.read`, `stats`, `dlq` and the other [inspection methods](../core/inspecting.md) return payloads as `unknown`.
