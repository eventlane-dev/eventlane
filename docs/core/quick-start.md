# Quick start

From nothing to a working event bus in five minutes, in plain Node.js. On NestJS use the [NestJS getting started](../nestjs/getting-started.md) instead.

## 1. Start Redis

```bash
docker run --rm --name my-redis -p 6379:6379 redis:7 redis-server --appendonly yes
```

## 2. Create a project

```bash
mkdir lane-quickstart && cd lane-quickstart
npm init -y
npm pkg set type=module
npm install @eventlane/core ioredis
```

## 3. Write `app.js`

```js
import { EventLaneBus } from '@eventlane/core';

const bus = new EventLaneBus({
  redisUrl: 'redis://localhost:6379',
  consumerName: 'notifications',          // this process is the "notifications" consumer
  retry: { attempts: 3, backoff: { type: 'fixed', delay: 1000 } },
});

let attempts = 0;
bus.on('users', 'user.created', async (payload, meta) => {
  attempts++;
  if (attempts === 1) throw new Error('mail server is down'); // fails once, then succeeds
  console.log(`welcome mail to ${payload.email} (attempt ${meta.attempt})`);
});

await bus.start();
await bus.emit('users', 'user.created', { id: 1, email: 'ada@example.com' });

setTimeout(async () => {
  console.log(await bus.stats('users'));
  await bus.close();
}, 3000);
```

## 4. Run it

```bash
node app.js
```

You should see the welcome mail on the **second** attempt, after one second, and then the stats of the topic: one event, the `notifications` consumer with nothing pending and no lag.

## What just happened

- `emit` stored the event in the `users` topic in Redis. It stays there after it is handled.
- The `notifications` consumer received it. The handler threw, so EventLane waited one second and delivered it again.
- A second consumer, in this or another process, would have received the same event independently: give it another `consumerName`.

## Next

- Add the [dashboard](../dashboard/getting-started.md) to see this in a browser.
- [Concepts](concepts.md) explains the four names you just used, [Recipes](recipes.md) shows common tasks and [Troubleshooting](troubleshooting.md) answers the usual questions.
