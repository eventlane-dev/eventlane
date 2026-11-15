// The same events in plain Node.js, without NestJS: `pnpm --filter @eventlane/example-typed start:plain`
import { EventLaneBus } from '@eventlane/core';
import type { AppEvents } from './events';

// the type argument is all it takes; leave it out and everything is untyped again
const bus = new EventLaneBus<AppEvents>({
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6390',
  prefix: 'example-typed',
  consumerName: 'plain',
});

bus.on('users', 'user.registered', async (user) => {
  console.log(`[plain] registered ${user.email}`); // user: { id: number; email: string }
});
bus.on('orders', (payload, meta) => {
  console.log(`[plain] ${meta.eventName}`, payload); // payload: the union of the orders payloads
});

async function main() {
  await bus.start();
  await bus.emit('users', 'user.registered', { id: 1, email: 'grace@example.com' });
  await bus.emit('orders', 'order.placed', { orderId: 1, userId: 1, total: 12 });

  // await bus.emit('orders', 'order.placed', { orderId: 1 });          // error: userId and total missing
  // await bus.emit('users', 'order.placed', { orderId: 1 });           // error: not an event of "users"

  setTimeout(() => bus.close(), 1000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
