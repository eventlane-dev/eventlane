# Redis data model

What `@eventlane/core` writes to Redis, useful for debugging with `redis-cli`. This is the only page that uses Redis vocabulary on purpose; see the [mapping](concepts.md#mapping-to-redis-and-kafka).

`<p>` is the key prefix (default `events`).

| Key | Type | Purpose |
|---|---|---|
| `<p>:<topicName>` | stream | All events of a topic, e.g. `events:users`. Each `consumerName` is a Redis **consumer group** on it; each `instanceName` is a Redis **consumer** in that group. |
| `<p>:<topicName>:dlq` | stream | Events that exhausted their retries. |
| `<p>:<topicName>:<consumerName>:retry` | sorted set | Events waiting for a retry; score = due time (Redis `TIME`, ms), member = JSON `{ id, event, payload, headers, attempt }` (`payload` and `headers` are the original JSON strings, `attempt` counts deliveries so far). A claimed member is re-scored to now + `claimIdleMs` (a lease) with `attempt` bumped, and removed on completion. |
| `<p>:dedup:<topicName>:<consumerName>:<eventId>` | string | `p` (processing lease, `PX claimIdleMs`) or `d` (done, `EX dedupTtlSeconds`). `eventId` is the original event id. |
| `<p>:idem:<topicName>:<key>` | string | Producer idempotency key mapping to the stored event id (`EX dedupTtlSeconds`). |

## Stream entry fields

Each `XADD` entry has flat string fields:

| Field | Example | Description |
|---|---|---|
| `event` | `user.created` | The `eventName`. |
| `payload` | `{"id":1}` | JSON-serialized payload. |
| `attempt` | `1` | Delivery attempt (increments on retry). |
| `headers` | `{"correlationId":"abc"}` | JSON-serialized headers. |

The timestamp comes from the entry id (`<ms>-<seq>`).

## Dead-letter entry fields

`event`, `payload`, `headers`, `consumer` (the `consumerName`), `attempt`, `error` (message), `stack`, `originalId`, `failedAt`.

## Useful commands

```bash
redis-cli XRANGE events:users - + COUNT 5          # first events of the topic
redis-cli XINFO GROUPS events:users                # consumers (groups): pending, lag
redis-cli XINFO CONSUMERS events:users notifications   # instances of a consumer
redis-cli XPENDING events:users notifications      # pending summary for a consumer
redis-cli XLEN events:users:dlq                    # size of the dead-letter stream
```

## Notes

- Redis Cluster would need hash tags (`{topicName}`) so related keys share a slot. Not supported.
- Instances are created in Redis implicitly; cleanly stopped instances remove theirs.
