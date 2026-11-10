# Production checklist

Go through this list before running EventLane for real traffic. Each item links to the page that explains it.

## Redis

- [ ] **Persistence is on** (`appendonly yes`). Without it a Redis restart loses every event. [Redis setup](operations.md#redis-setup)
- [ ] **Redis 6.2 or newer**, 7 preferred (exact lag numbers).
- [ ] **`maxmemory-policy noeviction`**. An eviction policy can delete event data silently.
- [ ] **Enough memory for retention.** Topics keep about 1 000 000 events by default. Multiply by your payload size, and set `retention` per topic where that is too much or too little. [Retention](operations.md#retention)
- [ ] **Not Redis Cluster.** EventLane uses keys that must live on one node; use a single primary (with replicas or Sentinel for failover).
- [ ] Failover can lose the last writes (replication is asynchronous). Handlers should tolerate a few lost events, or use an [outbox](patterns.md#outbox).

## Handlers

- [ ] **Idempotent** (or `dedup: true`). Delivery is at-least-once, so a handler can run twice. [Reliability](reliability.md)
- [ ] **`claimIdleMs` is above your slowest handler.** Otherwise a slow handler's event is claimed by another instance and runs twice. [Crash recovery](reliability.md#crash-recovery)
- [ ] **Do not rely on order** unless you run one instance with `concurrency: 1` and no failures. [Ordering](reliability.md#ordering)
- [ ] **One consumer per independent job.** Two handlers of one consumer for the same event are retried together; EventLane logs a warning for that when a `logger` is set.
- [ ] **Retry policy fits the work.** Defaults are 5 attempts with exponential backoff. [Retries](reliability.md#retries-and-backoff)

## Producers

- [ ] **`emit` errors are handled.** If Redis is unreachable long enough, `emit` rejects and the event is not stored. [When Redis is unavailable](reliability.md#when-redis-is-unavailable)
- [ ] **Database change plus event** go through an [outbox](patterns.md#outbox) when losing the event is not acceptable.
- [ ] **`idempotencyKey`** is set where the caller may retry (HTTP requests, jobs).
- [ ] **Payloads are small.** Put ids in events and read the data from your database, not whole documents.

## Running instances

- [ ] **Graceful shutdown is wired.** Call `await bus.close()` on `SIGTERM` (in Nest: `app.enableShutdownHooks()`), and keep the platform's stop timeout above `shutdownTimeoutMs`. [Graceful shutdown](reliability.md#graceful-shutdown)
- [ ] **`instanceName` is unique per process.** Leave it generated unless you have a reason.
- [ ] **A `logger` is set** so retries, claims and warnings are visible.

## Observability

- [ ] **Metrics and alerts** on lag, pending and dead letters. [Metrics](patterns.md#metrics)
- [ ] **Dead letters are reviewed** and either fixed and replayed or removed. [Dead-letter stream](reliability.md#dead-letter-stream)
- [ ] **A health check** that proves Redis answers. [Health check](patterns.md#health-check)

## Dashboard (if you use it)

- [ ] **Behind authentication.** Set `authorize`, or mount it behind your own auth middleware. [Dashboard overview](../dashboard/overview.md)
- [ ] **`readOnly`** unless people really need to retry, delete or replay from the UI.
- [ ] **`redact` / `hidePayloads`** configured when payloads hold personal data.
