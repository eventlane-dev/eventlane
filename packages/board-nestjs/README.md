# @eventlane/board-nestjs

`BoardModule`: the [EventLane](https://www.npmjs.com/package/@eventlane/core) dashboard inside a NestJS app, on a route you choose. It finds the bus of `EventLaneModule` by itself and works on the Express and Fastify platforms.

> **The dashboard has no login of its own.** Mount it behind your authentication (middleware or the `authorize` option) or on an internal network. It is read-only unless you pass `readOnly: false`.

## Install

```bash
npm install @eventlane/board-nestjs @eventlane/board-express @eventlane/nestjs @eventlane/core
# on the Fastify platform install @eventlane/board-fastify instead of @eventlane/board-express
```

## Use it

```ts
@Module({
  imports: [
    EventLaneModule.forRoot({ redisUrl: process.env.REDIS_URL }),
    BoardModule.forRoot({
      route: '/admin/events',
      authorize: (req) => req.user?.isAdmin, // Nest guards do not apply here
    }),
  ],
})
export class AppModule {}
```

Open `/admin/events/` on your app. Writes (retry, purge, replay) are off unless you set `readOnly: false`.

## Documentation

- [Dashboard: getting started](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#nestjs) and [options](https://eventlane-dev.github.io/eventlane/dashboard/getting-started#options)

## License

MIT. Source and issues: [github.com/eventlane-dev/eventlane](https://github.com/eventlane-dev/eventlane).
