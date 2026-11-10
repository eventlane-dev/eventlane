# Comparison and when to use EventLane

## The problem it solves

You are building a monolith (or a few services). You already run Redis (for BullMQ, cache, sessions) and want modules to communicate through events so they stay decoupled, with events that survive restarts and can be handled by several independent receivers. Kafka or RabbitMQ would be a whole new infrastructure to run.

## vs other options

| | In-process emitter (`EventEmitter`, `@nestjs/event-emitter`) | BullMQ | Redis Pub/Sub | **EventLane** | Kafka |
|---|---|---|---|---|---|
| Survives restarts | no | yes | no | yes | yes |
| Multiple instances | no | yes | yes | yes | yes |
| One event, many independent receivers | in-process only | no (one job, one worker) | yes, but fire-and-forget | **yes (consumers)** | yes |
| Load balancing inside a receiver | n/a | yes | no | yes | yes (partitions) |
| Retry / backoff | no | yes | no | yes | manual |
| Replay history | no | no | no | yes (retention-bound) | yes |
| Extra infrastructure | none | Redis | Redis | Redis | Kafka cluster |
| Throughput ceiling | in-process | high | high | tens of thousands of events/s per Redis, one process (see [Performance](core/operations.md#performance)) | millions/s |
| Ordering guarantees | n/a | none | n/a | only with one instance, `concurrency: 1` and no retries | per partition |

## Use EventLane when

- You want domain events between modules/services and Redis is already there.
- You need several independent receivers per event, persistence and retries.
- You expect to split the monolith later: consumer and topic names carry over to separate services unchanged.

## Use BullMQ instead when

- It is a **job**: one piece of work, one worker, results, priorities, scheduled or delayed jobs, rate limiting. EventLane is for facts that happened ("user.created"), not commands.
- They are complementary: a EventLane handler can enqueue a BullMQ job.

## Use Kafka (or similar) when

- You need partitioning with per-key ordering, very high throughput, long retention on disk, or a data-platform ecosystem (connectors, stream processing).
- Topics, event names and consumer names map directly to Kafka topics, message keys and consumer groups ([mapping](core/concepts.md#mapping-to-redis-and-kafka)), so handlers written against EventLane carry their structure over.

## Known limits

- Everything lives in Redis memory (retention is bounded by RAM).
- At-least-once only; handlers must tolerate duplicates.
- No partitions and no Redis Cluster.
