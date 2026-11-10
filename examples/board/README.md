# Example: the EventLane board on Express

An Express app that generates demo traffic (users and orders, with failing handlers that produce retries and dead letters, and a consumer without instances that builds up lag) and mounts the dashboard on `/admin/events`. It redacts e-mail addresses in everything the board shows, allows writes (retry and delete dead letters, replay, remove consumers, test events) and logs them with `onWrite`.

## Run

Needs Redis (`pnpm redis:up` at the repository root, on `localhost:6390`) and the built packages (`pnpm build`), both from the repository root.

```bash
pnpm --filter @eventlane/example-board start      # run once
pnpm --filter @eventlane/example-board dev        # restart on changes, including when a package it uses is rebuilt
```

To work on a package at the same time, keep it rebuilding in another terminal (for example `pnpm --filter @eventlane/core dev`); `dev` restarts the example after each rebuild.

Then open http://localhost:3000/admin/events.

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6390` | The Redis to use. |
| `PORT` | `3000` | The HTTP port. |
| `BOARD_READ_ONLY` | `false` | `true` makes the board read-only. |

For the same kind of app without the dashboard see [examples/express](../express); with NestJS see [examples/nestjs](../nestjs).
