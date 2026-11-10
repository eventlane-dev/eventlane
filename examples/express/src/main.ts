import { EventLaneBus } from '@eventlane/core';
import express from 'express';

// One bus per process. `consumerName` is the default consumer of the handlers below.
const bus = new EventLaneBus({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6390',
  prefix: 'example-express',
  consumerName: 'emails',
  retry: { attempts: 3, backoff: { type: 'fixed', delay: 2000 } },
});

// "emails" is one consumer: if this app runs on several servers, each event is handled by one.
bus.on('users', 'user.created', async (user: { email: string }, meta) => {
  console.log(`[emails] welcome mail to ${user.email} (attempt ${meta.attempt})`);
});

// "analytics" is another consumer: it gets its own copy of every event of the topic.
bus.on(
  'users',
  (payload, meta) => {
    console.log(`[analytics] ${meta.eventName} ${JSON.stringify(payload)}`);
  },
  { consumerName: 'analytics' },
);

await bus.start();

const app = express();
app.use(express.json());

// Emit from anywhere in your request handlers.
app.post('/users', async (req, res) => {
  const user = { id: Date.now(), email: String(req.body?.email ?? 'ada@example.com') };
  const eventId = await bus.emit('users', 'user.created', user, {
    idempotencyKey: `user-${user.id}`,
  });
  res.status(201).json({ user, eventId });
});

// Expose what the bus knows through your own route (the dashboard is a separate package).
app.get('/stats/:topic', async (req, res) => {
  res.json(await bus.stats(req.params.topic, { instances: true }));
});
app.get('/dead-letters/:topic', async (req, res) => {
  res.json(await bus.dlq.list(req.params.topic, { count: 20 }));
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`http://localhost:${port}  (POST /users, GET /stats/users)`);
});

// Stop reading, let running handlers finish, then close the connections.
process.on('SIGINT', async () => {
  server.close();
  await bus.close();
  process.exit(0);
});
