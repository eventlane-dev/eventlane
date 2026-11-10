# @eventlane/board-express

Mounts the EventLane dashboard into an Express app: `createBoard({ buses }).router`.

> Part of [EventLane](../../README.md).

## Build and test

```bash
pnpm --filter @eventlane/board-express build
pnpm --filter @eventlane/board-express dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/board-express test      # needs Redis and the built UI (`pnpm --filter @eventlane/board-ui build`)
pnpm --filter @eventlane/board-express typecheck
```

A runnable app: [examples/board](../../examples/board).

## Documentation

- [Dashboard: getting started](../../docs/dashboard/getting-started.md#express)
