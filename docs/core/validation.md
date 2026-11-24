# Validation

[Typed events](typed-events.md) are checked by the compiler only. A payload from another service, an older version or a script can still differ from the type. Give an event a **schema** and EventLane checks the payload at runtime, when it is emitted and when it is received.

Schemas use the [Standard Schema](https://standardschema.dev) interface, so zod (3.24+ and 4), valibot, ArkType and every other library that implements it work. EventLane depends on none of them.

## Declare schemas

`schemas` maps `topicName` to `eventName` to a schema. Events without a schema are not validated.

```ts
import { z } from 'zod';
import { EventLaneBus, type InferEvents } from '@eventlane/core';

const schemas = {
  users: {
    'user.created': z.object({ id: z.number(), email: z.string().email() }),
    'user.deleted': z.object({ id: z.number() }),
  },
};

// the payload types come from the schemas, no separate interfaces needed
const bus = new EventLaneBus<InferEvents<typeof schemas>>({
  redisUrl,
  consumerName: 'notifications',
  schemas,
});
```

`schemas` alone does not change the types: without a type argument the bus stays untyped. `InferEvents` is optional. It takes each payload type from the schema's **output**, so a field that has a default is required in the type of `emit`: for producers make such a field optional in the schema, or declare the event map yourself with the input types. With an event map you wrote yourself (`new EventLaneBus<AppEvents>({ schemas })`), the compiler checks that each schema produces the payload type of its event.

The runnable [`examples/validation`](https://github.com/eventlane-dev/eventlane/tree/main/examples/validation) uses zod.

## What is checked

| When | What happens to an invalid payload |
|---|---|
| `emit` | `emit` rejects with a `ValidationError`. Nothing is stored in Redis. |
| Receive | The event is not passed to any handler. It goes straight to the [dead letters](reliability.md#dead-letters) without retries (the payload will not change), with the error `invalid payload: <issues>`. With `onInvalid: 'drop'` it is acknowledged and skipped instead. |

When a schema is declared for an event, the handler receives the schema's **output**. A schema that applies defaults or transforms values (`z.coerce.date()`, `.default(...)`) therefore changes what `emit` stores and what the handler sees: the value is validated, then the output is serialized as JSON.

`validate` chooses where the check runs:

| `validate` | Behavior |
|---|---|
| `'both'` (default) | On `emit` and on receive. |
| `'emit'` | Only on `emit`. |
| `'receive'` | Only on receive. Use it for a consumer of events written by services you do not control. |
| `false` | Never; schemas are only used for types (with `InferEvents`). |

Checking on both sides is intentional: `emit` fails fast in the producing service, and the check on receive protects a consumer from events written by an older version, another language or a script.

## ValidationError

```ts
import { ValidationError } from '@eventlane/core';

try {
  await bus.emit('users', 'user.created', { id: 1, email: 'nope' });
} catch (error) {
  if (error instanceof ValidationError) {
    error.topicName;   // 'users'
    error.eventName;   // 'user.created'
    error.issues;      // [{ message: 'Invalid email', path: ['email'] }]  (Standard Schema issues)
  }
}
```

## Invalid events on the receiving side

- A dead letter caused by validation looks like any other, with `reason: 'validation'` and an `error` that starts with `invalid payload:` and lists the issues (`email: Invalid email`). `attempt` is the delivery on which it failed. Find them with `bus.dlq.list(topicName)` (check `reason`) or in the [dashboard](../dashboard/using.md), which marks them **invalid payload**.
- `dlq.retry` puts the event back in the retry set. It fails validation again unless the schema (or the consumer's code) changed in the meantime, so fix the cause first.
- The check runs before deduplication and before handlers, once per delivery. An event no handler listens to is acknowledged without being validated.
- A schema whose `validate` function throws or rejects is treated like an invalid payload with the thrown message.

## Schemas and versions

Events already stored in Redis keep the shape they had when they were emitted. When you tighten a schema, older events that are still in the topic or in the retry set fail validation on receive. Add fields as optional (or give them a default) first, and tighten the schema after the old events are gone.

## What it does not do

- No schema registry and no versioning: the schema lives in your code. Share schemas between services in a package, the same way as [typed events](typed-events.md#share-the-types-between-services).
- Headers and `eventName` are not validated.
- Inspection (`read`, `readPage`, `dlq.list`, ...) returns what is stored, without validation.
