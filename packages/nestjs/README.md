# @eventlane/nestjs

NestJS integration for EventLane: `EventLaneModule` (`forRoot`, `forRootAsync`, `forFeature`), the injectable `EventLaneEmitter`, `@InjectLaneEmitter` and `@OnLaneEvent`.

> Part of [EventLane](../../README.md).

## Build and test

```bash
pnpm --filter @eventlane/nestjs build
pnpm --filter @eventlane/nestjs dev        # rebuild on every change (watch mode)
pnpm --filter @eventlane/nestjs test      # needs Redis; it runs against the sources of `@eventlane/core`
pnpm --filter @eventlane/nestjs typecheck
```

A runnable app: [examples/nestjs](../../examples/nestjs).

## Documentation

- [Getting started](../../docs/nestjs/getting-started.md), [Module, emitters and handlers](../../docs/nestjs/guide.md), [Configuration](../../docs/nestjs/configuration.md)
