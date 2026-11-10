# Example: NestJS monolith with the dashboard

Two modules consume the same `users` topic: `notifications` and `webhooks` are separate consumers, so each gets its own copy of `user.created`. `UsersModule` only emits. `BoardModule` serves the EventLane dashboard on `/admin/events` (writes enabled in this demo).

## Run

Needs Redis (`pnpm redis:up` at the repository root, on `localhost:6390`) and the built packages (`pnpm build`), both from the repository root.

```bash
pnpm --filter @eventlane/example-nestjs start      # run once
pnpm --filter @eventlane/example-nestjs dev        # restart on changes, including when a package it uses is rebuilt
```

To work on a package at the same time, keep it rebuilding in another terminal (for example `pnpm --filter @eventlane/core dev`); `dev` restarts the example after each rebuild.

It keeps running and registers a user every few seconds. Open http://localhost:3000/admin/events to watch the events and both consumers. Expected output of the app:

```
[main] registered user 1762725960000
[notifications] welcome email to ada@example.com (attempt 1)
[webhooks] POST user.created {"id":1762725960000,"email":"ada@example.com"}
```

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6390` | The Redis to use. |
| `PORT` | `3000` | The HTTP port. |

For plain Express see [examples/express](../express) (no dashboard) and [examples/board](../board) (with the dashboard).
