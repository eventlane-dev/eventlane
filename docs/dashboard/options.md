# Options and security

Settings of `createBoard(options)` (the same for the Express and Fastify adapters; `BoardModule` adds a few of its own, see [Getting started](getting-started.md#nestjs)), how to keep payloads private and what to do before exposing the board.

## Options

`createBoard(options)` takes:

| Option | Default | Description |
|---|---|---|
| `buses` | required | A `EventLaneBus`, an array of them (named `bus-1`, `bus-2`, ...) or an object (its keys are the names). With several, the header shows a selector. |
| `readOnly` | `true` | The board refuses every write. Set `false` to allow the actions above. |
| `authorize` | none | `(request, action) => boolean \| Promise<boolean>`, called for every request with the framework's request object (Express, Fastify or the raw request) and the action: `'read'`, `'dlq.retry'`, `'dlq.purge'`, `'consumer.replay'`, `'consumer.remove'`, `'topic.delete'` or `'event.emit'`. Return `false` to answer 403. Use it for per-user rules, for example let everyone read but only admins delete. |
| `onWrite` | none | `(entry) => void \| Promise<void>`, called after every successful write for an audit log. `entry` is `{ action, bus, topicName, consumerName?, detail, request }`. A failure in it does not fail the write (it goes to `onError`). |
| `allowedOrigins` | none | Origins (e.g. `https://admin.example.com`) that may send writes besides the host serving the board. Only needed behind a proxy that rewrites the `Host` header. |
| `redact` | none | `(event) => event`, applied to every payload and header set before it leaves the server. `event` is `{ topicName, eventName, payload, headers }`. |
| `hidePayloads` | `false` | Never send payloads at all (lists and details show metadata only). |
| `maxPayloadBytes` | `262144` | Payloads longer than this (as JSON) are not sent; the UI says so. |
| `concurrency` | `8` | How many requests run at once, so a few open tabs cannot load Redis. |
| `rateLimit` | `{ max: 100, windowMs: 10000 }` | Requests allowed per client in a time window; over it the board answers `429`. `false` turns it off. See [Rate limit](#rate-limit). |
| `onError` | none | Called with unexpected errors, which are answered as `500 internal error` without details. |

### Rate limit

It is a token bucket, so short bursts are fine, and the answer to a request over the limit has a `Retry-After` header. The client is the request's IP address (`req.ip`); behind a proxy set Express's `trust proxy` or Fastify's `trustProxy` so it is the real client and not the proxy. The UI polls well below the default.

### Keeping payloads private

Payloads can hold personal data. Before exposing the board, decide what it may show:

```ts
createBoard({
  buses: bus,
  redact: (event) => ({
    ...event,
    payload: maskEmails(event.payload),
    headers: { ...event.headers, authorization: '***' },
  }),
  // or: hidePayloads: true
});
```

`redact` runs for events, event details, dead letters and previews alike.

## Security notes

- Put authentication in front of the board (`app.use('/admin/events', requireAdmin)`); `authorize` is for finer rules.
- The board is read-only by default. Keep it that way for anything reachable by many people, and when you enable writes, restrict the destructive actions with `authorize` and record them with `onWrite`.
- Writes are protected against cross-site requests: they must carry the `X-EventLane-Board: 1` header (which a foreign page cannot send without a CORS preflight that the board never answers) and, when the browser sends an `Origin`, it must be the board's own host (or in `allowedOrigins`). Do not add permissive CORS headers in front of the board.
- The page is served with a strict `Content-Security-Policy` (own origin only, no framing) and the API with `Cache-Control: no-store`.
- Stack traces of failed handlers are shown in dead letters; they can reveal paths and internals, so keep the board internal.
