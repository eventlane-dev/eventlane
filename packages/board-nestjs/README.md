# @eventlane/board-nestjs

`BoardModule` for NestJS: serves the EventLane dashboard on a route of your app (Express or Fastify platform) and finds the bus of `EventLaneModule` by itself.

> Part of [EventLane](../../README.md).

## Build and test

```bash
pnpm --filter @eventlane/board-nestjs build
pnpm --filter @eventlane/board-nestjs dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/board-nestjs test      # needs Redis and the built UI (`pnpm --filter @eventlane/board-ui build`)
pnpm --filter @eventlane/board-nestjs typecheck
```

A runnable app: [examples/nestjs](../../examples/nestjs).

## Documentation

- [Dashboard: getting started](../../docs/dashboard/getting-started.md#nestjs)
