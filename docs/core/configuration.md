# Configuration reference

NestJS has its own options on top of these: see [NestJS configuration](../nestjs/configuration.md). Terms: [Concepts](concepts.md).

## Redis connection

Provide **exactly one** of:

| Option | Type | Description |
|---|---|---|
| `redisUrl` | `string` | A connection URL: `redis://[:password@]host:port[/db]`, `rediss://` for TLS. |
| `redis` | `RedisConnection \| Redis` | A connection object, or an existing `ioredis` client (reused and never closed by EventLane). |

Both or neither throws a configuration error at startup.

`RedisConnection` accepts the usual [ioredis options](https://github.com/redis/ioredis), the common ones being:

| Field | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | `localhost` | Redis host. |
| `port` | `number` | `6379` | Redis port. |
| `username` | `string` | none | ACL user. |
| `password` | `string` | none | Password. |
| `db` | `number` | `0` | Database index. |
| `tls` | `object` | none | TLS options; presence enables TLS. |
| `sentinels` | `{ host, port }[]` | none | Sentinel nodes (with `name` for the master). |
| `name` | `string` | none | Sentinel master name. |

EventLane duplicates the connection for blocking reads, so one setting configures every connection it opens.

## Bus options (`new EventLaneBus(options)`)

| Option | Type | Default | Description |
|---|---|---|---|
| `redisUrl` / `redis` | see above | required | Redis connection. |
| `consumerName` | `string` | none | Default consumer for subscriptions that do not set one. Required if any subscription omits `consumerName`. |
| `instanceName` | `string` | `hostname-pid-random` | Unique per running instance within a consumer. Override only for stable names in logs; never reuse across live instances. |
| `prefix` | `string` | `events` | Prefix of every Redis key. |
| `blockTimeMs` | `number` | `5000` | `XREADGROUP BLOCK` timeout. Affects how fast `close()` can stop the loops. |
| `batchSize` | `number` | `50` | Max events fetched per read. |
| `retry` | `{ attempts, backoff }` | `{ attempts: 5, backoff: { type: 'exponential', delay: 1000, maxDelay: 60000 } }` | Default retry policy, see [Reliability](reliability.md#retries-and-backoff). |
| `claimIdleMs` | `number` | `60000` | Idle time after which a pending event is claimed from a dead instance. |
| `claimIntervalMs` | `number` | `15000` | How often the claim worker runs. |
| `retryPollMs` | `number` | `1000` | How often due retries are picked up from the consumer's retry set. |
| `dedupTtlSeconds` | `number` | `86400` | Lifetime of the "done" dedup marker and of producer idempotency keys. |
| `dlqMaxLen` | `number` | `10000` | Approximate cap of each topic's dead-letter stream. |
| `shutdownTimeoutMs` | `number` | `10000` | Max wait for in-flight handlers in `close()`. |
| `retention` | `{ maxLen?, maxAgeMs? }` \| `false` | `{ maxLen: 1000000 }` | Retention of topics that set none of their own. `false` keeps everything. |
| `topics` | `Record<topicName, TopicOptions>` | `{}` | Per-topic settings (below). |
| `logger` | `{ debug, info, warn, error }` | silent | Where the library logs, including a warning at startup when two handlers of one consumer match the same event. |

## Per-topic options (`topics[topicName]`)

| Option | Type | Default | Description |
|---|---|---|---|
| `retention` | `{ maxLen?, maxAgeMs? }` \| `false` | the bus `retention` | Retention of this topic; `false` keeps everything. |
| `retention.maxLen` | `number` | none | Approximate maximum number of events (`MAXLEN ~`). |
| `retention.maxAgeMs` | `number` | none | Approximate maximum age (`MINID ~`). |

If both `maxLen` and `maxAgeMs` are set, both apply. Trimming runs on every `emit` to the topic and is approximate; see [Operations](operations.md#retention). The dead-letter stream is capped separately by `dlqMaxLen`.

## Subscription options (`bus.on(..., options)`)

| Option | Type | Default | Description |
|---|---|---|---|
| `consumerName` | `string` | bus default | Consumer for this subscription. |
| `concurrency` | `number` | `1` | Parallel handlers per instance. Above 1 handlers overlap, so events are not handled in order (see [Ordering](reliability.md#ordering)). |
| `dedup` | `boolean` | `false` | Skip already-processed event ids for this consumer. |
| `startFrom` | `'$' \| '0'` | `'$'` | Starting point for a consumer that does not exist yet. |
| `retry` | like bus `retry` | bus value | Override the retry policy. |

## `emit` options

| Option | Type | Description |
|---|---|---|
| `idempotencyKey` | `string` | If an event with the same key was emitted within `dedupTtlSeconds`, the call returns the original id and stores nothing. |
| `headers` | `Record<string, string>` | Extra metadata delivered to handlers in `meta.headers` (e.g. `correlationId`). |
