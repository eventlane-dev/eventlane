# @eventlane/core

The framework-independent EventLane library on `ioredis`: topics, consumers, retries and dead letters, deduplication, replay, retention and stats. Use it from any Node.js app.

> Part of [EventLane](https://github.com/eventlane-dev/eventlane).

## Install

```bash
npm install @eventlane/core ioredis
```

## Build and test

```bash
pnpm --filter @eventlane/core build
pnpm --filter @eventlane/core dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/core test      # needs Redis (`pnpm redis:up` at the repository root)
pnpm --filter @eventlane/core typecheck
```

Source in `src/`, tests in `test/` (they run against a real Redis).

## Documentation

- [Getting started](https://eventlane-dev.github.io/eventlane/core/getting-started), [Concepts](https://eventlane-dev.github.io/eventlane/core/concepts), [Core API](https://eventlane-dev.github.io/eventlane/core/api)
- [Reliability](https://eventlane-dev.github.io/eventlane/core/reliability), [Operations](https://eventlane-dev.github.io/eventlane/core/operations), [Configuration](https://eventlane-dev.github.io/eventlane/core/configuration)
