# Concepts and naming

Everything in EventLane is addressed with four names. They are used the same way in the code, the options and these docs.

| Name | What it identifies | Example | Who chooses it |
|---|---|---|---|
| **`topicName`** | A channel of related events. | `users`, `orders` | You |
| **`eventName`** | The kind of event inside a topic. | `user.created` | You |
| **`consumerName`** | A logical receiver of events. | `notifications`, `webhooks` | You |
| **`instanceName`** | One running process of a consumer. | `web-1-4312-a9f3` | EventLane (you may override) |

Plus the **payload**: the JSON data that travels with an event.

## What each one means

### `topicName`: where events live

A topic is a named channel of related events, usually one business area. You **emit to** a topic and a consumer **listens to** a topic. It is the unit of storage, retention and ordering. Events stay stored in the topic after they are handled, until [retention](operations.md#retention) trims them. A topic carries many event names: `users` can carry `user.created`, `user.updated` and `user.deleted`. Pick topics by business area, not by event.

### `eventName`: what happened

The name of the event inside a topic, such as `user.created`. It is stored next to the payload. A handler can listen to one `eventName`, or to every event of a topic. Names are free-form; `<entity>.<past-tense-verb>` is a good convention.

### `consumerName`: who receives

A consumer is **one logical receiver**: a name you give to a piece of your system that reacts to events (`notifications`, `webhooks`, `reporting`). Two rules define it:

1. **Fan-out between consumers.** If `notifications` and `webhooks` both listen to `users`, every event is delivered to both.
2. **Load balancing inside a consumer.** If `notifications` runs as three processes, exactly one of them handles any given event.

In a NestJS monolith a consumer usually corresponds to a module (see the [NestJS guide](../nestjs/guide.md)). If you later split the monolith, the same `consumerName` keeps working in the new service.

### `instanceName`: which process

One running process of a consumer. If `notifications` runs on three servers there are three instances. EventLane generates the name (`hostname-pid-random`) and you normally never see it. It only has to be unique among *live* instances of the same consumer, which is why it is generated. Override it (`instanceName` option) only for stable names in logs.

## How they fit together

```
emit(topicName 'users', eventName 'user.created', payload)
                |
         topic "users"
        /                          \
consumer "notifications"        consumer "webhooks"
 instance web-1  web-2  web-3     instance web-1
 (only one handles the event)     (handles the event)
```

Anything with access to Redis can `emit`. Anything can listen as long as it has a `consumerName`. A process can be only a producer, only a consumer, or both.

## Delivery guarantees

- **At-least-once.** An event is acknowledged only after the handler succeeds. If a handler throws or the process dies mid-handling, the event is delivered again. Your handlers should be idempotent, or use [deduplication](reliability.md#deduplication).
- **Persistent.** Events stay in the topic after they are consumed, until retention trims them. You can inspect and [replay](operations.md#replay) them.
- **Ordering.** Events of a topic are stored in the order they were emitted, but they are **handled in that order only in one situation**: a single instance of the consumer, `concurrency: 1` (the default) and no failing handlers. With several instances of a consumer the events are shared out and handled in parallel, so the order across instances is lost; a retried event runs after its backoff, so later events can overtake it; and with `concurrency` above 1 handlers overlap. There are no partitions or ordering keys. See [Ordering](reliability.md#ordering) for what to do when order matters.
- **Not exactly-once.** Nothing in Redis can promise that. Use deduplication.

## Filtering by event name

A consumer reads every event of a topic. If a handler listens to a specific `eventName`, other events of the topic are acknowledged without running it. Topics with very different event volumes are better split into separate topics.

## Naming rules

- Names may contain letters, digits, `.`, `-` and `_` only (checked at runtime); lowercase is recommended. `:` is not allowed because it separates the parts of Redis keys.
- `topicName` and `consumerName` are part of stored state: **renaming one later creates a new, empty one**. A renamed consumer starts where a new consumer starts (see `startFrom`) and the old one keeps its unread events.
- Choose `consumerName` by responsibility (`notifications`), not by technology (`redis-worker`) or machine.

## Mapping to Redis (and Kafka)

You do not need this to use the library; it helps when debugging.

| EventLane | Redis | Kafka (for comparison) |
|---|---|---|
| `topicName` | a **stream** (`events:users`) | topic |
| `eventName` | a field inside each stream entry | (message type, by convention) |
| `consumerName` | a **consumer group** | consumer group |
| `instanceName` | a **consumer** inside the group | a member of the group |
| event id | the stream entry id (`1762725960000-0`) | offset (roughly) |

Redis vocabulary appears only in [Redis data model](redis-data-model.md) and when quoting `redis-cli` commands.
