import { createBoard } from '@eventlane/board-express';
import { EventLaneBus } from '@eventlane/core';
import express from 'express';

const bus = new EventLaneBus({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6390',
  prefix: 'demo',
  consumerName: 'notifications',
  retry: { attempts: 3, backoff: { type: 'fixed', delay: 4000 } },
  topics: { users: { retention: { maxLen: 5000 } }, orders: { retention: { maxLen: 5000 } } },
});

// notifications: handles users, but cannot delete (so those events retry, then become dead letters)
bus.on('users', 'user.created', () => {});
bus.on('users', 'user.updated', () => {});
bus.on('users', 'user.deleted', () => {
  throw new Error('mail service is down');
});

// billing: handles orders; roughly one payment in four fails
bus.on(
  'orders',
  'order.paid',
  () => {
    if (Math.random() < 0.25) throw new Error('payment provider timeout');
  },
  { consumerName: 'billing' },
);
bus.on('orders', 'order.placed', () => {}, { consumerName: 'billing' });

// reporting: exists but has no running instance, so its lag grows
await bus.replay('orders', { consumerName: 'reporting', from: '$' });
await bus.replay('users', { consumerName: 'reporting', from: '$' });

await bus.start();

const names = ['ada', 'grace', 'linus', 'margaret', 'alan'];
const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)] as T;
let n = 0;
setInterval(async () => {
  n++;
  const who = pick(names);
  await bus.emit('users', pick(['user.created', 'user.updated', 'user.created', 'user.deleted']), {
    id: n,
    email: `${who}@example.com`,
    plan: pick(['free', 'pro']),
  });
  if (n % 2 === 0) {
    await bus.emit('orders', pick(['order.placed', 'order.paid']), {
      orderId: 1000 + n,
      total: Math.round(Math.random() * 20000) / 100,
      customer: who,
    });
  }
}, 700);

const app = express();
// put your own authentication in front of the board
app.use(
  '/admin/events',
  createBoard({
    buses: bus,
    // the board is read-only unless you say otherwise; this demo allows writes
    readOnly: process.env.BOARD_READ_ONLY === 'true',
    onWrite: (entry) => console.log('[board]', entry.action, entry.topicName, entry.detail),
    // hide e-mail addresses in everything the board shows
    redact: (event) => ({
      ...event,
      payload:
        event.payload && typeof event.payload === 'object' && 'email' in event.payload
          ? { ...event.payload, email: '***' }
          : event.payload,
    }),
  }).router,
);
const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`Board: http://localhost:${port}/admin/events`);
});

process.on('SIGINT', async () => {
  server.close();
  await bus.close();
  process.exit(0);
});
