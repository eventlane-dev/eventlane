# Example: Express with `@eventlane/core`

A plain Express app (no dashboard) that shows the core API: `emit` from a route, two consumers of one topic (`emails` and `analytics`), retries, and your own routes for `stats()` and the dead letters.

## Run

Needs Redis (`pnpm redis:up` at the repository root, on `localhost:6390`) and the built packages (`pnpm build`), both from the repository root.

```bash
pnpm --filter @eventlane/example-express start      # run once
pnpm --filter @eventlane/example-express dev        # restart on changes, including when a package it uses is rebuilt
```

To work on a package at the same time, keep it rebuilding in another terminal (for example `pnpm --filter @eventlane/core dev`); `dev` restarts the example after each rebuild.

Then, in another terminal:

```bash
curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"email":"ada@example.com"}'
curl localhost:3000/stats/users
```

Expected output of the app:

```
[emails] welcome mail to ada@example.com (attempt 1)
[analytics] user.created {"id":1762725960000,"email":"ada@example.com"}
```

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6390` | The Redis to use. |
| `PORT` | `3000` | The HTTP port. |

For the same kind of app with the dashboard see [examples/board](../board) (Express) and [examples/nestjs](../nestjs) (NestJS).
