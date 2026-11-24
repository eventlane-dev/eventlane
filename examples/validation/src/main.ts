import { EventLaneBus, ValidationError } from '@eventlane/core';
import { type AppEvents, schemas } from './schemas';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6390';
const prefix = 'example-validation';

// The service that receives the events. `validate: 'both'` (the default) checks them on emit
// and on receive.
const bus = new EventLaneBus<AppEvents>({
  redisUrl,
  prefix,
  consumerName: 'notifications',
  schemas,
  retry: { attempts: 3, backoff: { type: 'fixed', delay: 200 } },
});

bus.on('users', 'user.created', (user) => {
  // user is { id: number; email: string }, and the schema has been applied
  console.log('handled user.created', user);
});

// Another service (an older version, another language, a script) that does not validate.
const outsider = new EventLaneBus({ redisUrl, prefix, validate: false });

await bus.start();

// 1. A valid event; the schema's transform stores the e-mail address in lower case.
await bus.emit('users', 'user.created', { id: 1, email: 'Ada@Example.com' });

// 2. An invalid event is rejected on emit and never reaches Redis.
try {
  // the compiler sees a string here; only the schema knows it is not an e-mail address
  await bus.emit('users', 'user.created', { id: 2, email: 'not-an-email' });
} catch (error) {
  if (error instanceof ValidationError) {
    console.log('rejected on emit:', error.message);
    console.log('issues:', error.issues);
  } else {
    throw error;
  }
}

// 3. The outsider writes an invalid event straight into the topic. The receiving side checks
//    it too: it is not retried and goes to the dead letters, with reason "validation".
await outsider.emit('users', 'user.created', { id: 3, email: 'nope' });

await new Promise((resolve) => setTimeout(resolve, 1000));

const [dead] = await bus.dlq.list('users');
console.log('dead letter:', { reason: dead?.reason, attempt: dead?.attempt, error: dead?.error });

// clean up what the example wrote
await bus.deleteTopic('users', { confirm: true });
await outsider.close();
await bus.close();
