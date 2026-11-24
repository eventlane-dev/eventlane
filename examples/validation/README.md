# Example: validation with zod

[`src/schemas.ts`](src/schemas.ts) declares one zod schema per event. [`src/main.ts`](src/main.ts) shows what [validation](../../docs/core/validation.md) does:

1. A valid event is stored, and the schema's transform (lower-case e-mail) is applied.
2. An invalid event is rejected on `emit` with a `ValidationError` and never reaches Redis.
3. An invalid event written by a producer that does not validate is caught on receive: it is not retried and goes to the dead letters with `reason: 'validation'`.

Schemas are optional and any [Standard Schema](https://standardschema.dev) library works (zod, valibot, ArkType). The payload types come from the schemas with `InferEvents`.

## Run

Needs Redis (`pnpm redis:up` at the repository root, on `localhost:6390`) and the built packages (`pnpm build`), both from the repository root.

```bash
pnpm --filter @eventlane/example-validation start
```

It uses the key prefix `example-validation`, deletes its topic at the end, and honours `REDIS_URL`.
