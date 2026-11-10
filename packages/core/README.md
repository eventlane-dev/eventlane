# @eventlane/core

The framework-independent EventLane library on `ioredis`: topics, consumers, retries and dead letters, deduplication, replay, retention and stats. Use it from any Node.js app.

> Part of [EventLane](../../README.md).

## Build and test

```bash
pnpm --filter @eventlane/core build
pnpm --filter @eventlane/core dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/core test      # needs Redis (`pnpm redis:up` at the repository root)
pnpm --filter @eventlane/core typecheck
```

Source in `src/`, tests in `test/` (they run against a real Redis).

## Documentation

- [Getting started](../../docs/core/getting-started.md), [Concepts](../../docs/core/concepts.md), [Core API](../../docs/core/api.md)
- [Reliability](../../docs/core/reliability.md), [Operations](../../docs/core/operations.md), [Configuration](../../docs/core/configuration.md)
