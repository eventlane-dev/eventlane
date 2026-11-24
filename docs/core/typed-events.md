# Typed events

By default a payload is `any` and event names are free strings, so a typo in `'user.created'` or a missing field shows up at runtime, if at all. Describe your events once and the compiler checks every `emit` and `on`: the topic name, the event name and the payload.

Typing is **optional** and exists only at compile time. Nothing changes at runtime, and nothing validates the data that arrives unless you add [schemas](validation.md) (see [What it does not do](#what-it-does-not-do)). Using NestJS? See [Typed events in NestJS](../nestjs/typed-events.md).

## 1. Describe the events

One interface per topic maps each `eventName` to its payload type. One more interface maps each `topicName` to its events.

```ts
// events.ts
export interface UserEvents {
  'user.created': { id: number; email: string };
  'user.deleted': { id: number };
  'user.logged-out': undefined;            // an event without a payload (void works too)
}

export interface OrderEvents {
  'order.placed': { orderId: number; userId: number; total: number };
  'order.cancelled': { orderId: number; reason: string };
}

export interface AppEvents {
  users: UserEvents;
  orders: OrderEvents;
}
```

Use `interface` or `type`, whichever you prefer. Event names stay free-form (`<entity>.<past-tense-verb>` is a good convention, see [Concepts](concepts.md#eventname-what-happened)).

## 2. Give the bus the map

```ts
import { EventLaneBus } from '@eventlane/core';
import type { AppEvents } from './events';

const bus = new EventLaneBus<AppEvents>({ redisUrl, consumerName: 'notifications' });
```

That is all. Everything below is now checked.

### Emitting

```ts
await bus.emit('users', 'user.created', { id: 1, email: 'ada@example.com' });
await bus.emit('users', 'user.logged-out');                          // no payload needed
await bus.emit('users', 'user.created', { id: 1, email: 'a@b.com' }, { idempotencyKey: 'u-1' });

await bus.emit('users', 'user.created', { id: 1 });                  // error: email is missing
await bus.emit('users', 'user.creatd', { id: 1 });                   // error: unknown event name
await bus.emit('users', 'order.placed', { orderId: 1 });             // error: not an event of "users"
await bus.emit('nope', 'user.created', {});                          // error: unknown topic
```

The payload is required unless its type allows `undefined`.

### Listening

```ts
bus.on('users', 'user.created', async (payload) => {
  payload.email;                                    // string
});

bus.on('users', (payload, meta) => {
  // every event of the topic: payload is the union of the topic's payload types,
  // meta.eventName tells them apart
});

bus.on(['users', 'orders'], 'order.placed', (order) => order.total);   // event names of either topic
```

### Topic-bound emitter

`bus.emitter('users')` returns a `TopicEmitter<UserEvents>`:

```ts
const users = bus.emitter('users');
await users.emit('user.deleted', { id: 1 });
users.on('user.created', (payload) => payload.email);
```

## Adopt it step by step

You do not need a map for the whole app. Type one topic and leave the rest:

```ts
const users: TopicEmitter<UserEvents> = bus.emitter('users');   // an untyped bus works too
```

`TopicEmitter` takes the events of one topic as its type argument, so a module can type just the topic it works with. An untyped `new EventLaneBus(...)` stays fully untyped (payloads are `any`, names are any string), and a typed bus can be passed wherever an untyped one is expected, for example to the [dashboard](../dashboard/getting-started.md).

## Share the types between services

When you split a monolith, put the event interfaces in a small shared package (or a folder both services import) and import them with `import type`. Producer and consumer then agree at compile time, and the interfaces are erased from the build, so the services stay independent at runtime.

```ts
import type { OrderEvents } from '@acme/events';   // the same file in both services
```

Change a payload in one place and the compiler lists every emit and handler to update. Events already stored in Redis keep their old shape, so add fields as optional (or handle both shapes) when you change a payload that older events may still carry.

## What it does not do

- **No runtime validation by itself.** A payload from another service, an older version or a script can differ from the type. Add [schemas](validation.md) to check payloads when they are emitted and received; the types can then be inferred from the schemas (`InferEvents`).
- **Only declared names.** A typed bus refuses topic and event names you did not declare. For dynamic names use an untyped `EventLaneBus` (or a cast at that one call).
- **Inspection stays untyped.** `read`, `readPage`, `stats`, `dlq` and the other [inspection methods](inspecting.md) take any `topicName` and return payloads as `unknown`, because they show what is stored, which can be older than your types.

## Example

[`examples/typed`](https://github.com/eventlane-dev/eventlane/tree/main/examples/typed) has a runnable NestJS app and a plain Node.js script with the events of this page.
