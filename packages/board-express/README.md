# @eventlane/board-express

Mounts the EventLane dashboard into an Express app: `createBoard({ buses }).router`.

> Part of [EventLane](https://github.com/eventlane-dev/eventlane).

## Install

```bash
npm install @eventlane/board-express @eventlane/core express ioredis
```

## Build and test

```bash
pnpm --filter @eventlane/board-express build
pnpm --filter @eventlane/board-express dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/board-express test      # needs Redis and the built UI (`pnpm --filter @eventlane/board-ui build`)
pnpm --filter @eventlane/board-express typecheck
```

A runnable app: [examples/board](https://github.com/eventlane-dev/eventlane/tree/main/examples/board).

## Documentation

- [Dashboard: getting started](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#express)
