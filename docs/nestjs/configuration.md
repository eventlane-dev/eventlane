# NestJS configuration

Most options are the [core options](../core/configuration.md); this page lists what is specific to Nest. Terms: [Concepts](../core/concepts.md).

## `EventLaneModule.forRoot(options)` / `forRootAsync(options)`

`forRoot` takes the **same options as `new EventLaneBus(...)`** (see [core configuration](../core/configuration.md)): the Redis connection (`redisUrl` or `redis`, exactly one), `prefix`, `retry`, `claimIdleMs`, `topics` (retention), `logger` and the rest. Two differences (and one default: `logger` writes to the Nest `Logger` under the context `EventLane`, with `debug` silent):

| Core option | In `forRoot` | Why |
|---|---|---|
| `consumerName` | `defaultConsumerName` | In Nest each module is its own consumer (`forFeature`); this is only the fallback for handlers whose module does not set one. |
| `instanceName` | `instanceName` | Same. Generated per process by default. |

`forRootAsync` takes the same, produced by a factory:

| Option | Type | Description |
|---|---|---|
| `imports` | `ModuleMetadata['imports']` | Modules that provide what the factory injects (for example `ConfigModule`). |
| `inject` | `InjectionToken[]` | Providers passed to the factory. |
| `useFactory` | `(...args) => options \| Promise<options>` | Returns the `forRoot` options. |

## `EventLaneModule.forFeature(options)`

| Option | Type | Description |
|---|---|---|
| `topicNames` | `string[]` | Topics this module works with. Enables `@InjectLaneEmitter(topicName)` in the module and sets the default topic for `@OnLaneEvent`. |
| `consumerName` | `string` | Makes the module a consumer with this name. Falls back to `defaultConsumerName`. A module is a single consumer: two different names in one module fail at startup. |

## `@OnLaneEvent(eventName?, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `topicName` | `string` | the module's only topic | Topic the handler listens to. Required when the module lists several topics or none. |
| `consumerName` | `string` | the module's consumer, then `defaultConsumerName` | Consumer for this handler. |
| `concurrency` | `number` | `1` | Parallel handlers per instance. |
| `dedup` | `boolean` | `false` | Skip events this consumer already processed. See [Reliability](../core/reliability.md#deduplication). |
| `retry` | `RetryPolicy` | bus value | Override the retry policy. |
| `startFrom` | `'$' \| '0'` | `'$'` | Where a consumer that does not exist yet starts. |

Omit `eventName` to receive every event of the topic: `@OnLaneEvent({ topicName: 'orders' })`.

## Injection tokens

| Injection | Provided by | Type |
|---|---|---|
| `@InjectLaneEmitter(topicName)` | `forFeature({ topicNames })` of the same module | `TopicEmitter` |
| `EventLaneEmitter` (by class) | `forRoot` (global) | `EventLaneEmitter` |
| `@InjectEventLaneBus()` | `forRoot` (global) | `EventLaneBus` |
