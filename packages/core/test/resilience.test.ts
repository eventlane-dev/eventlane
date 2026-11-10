import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { EventLaneBus } from '../src';
import { sleep, waitFor } from './helpers';

// These tests start, kill and restart their own redis-server, so they never touch the shared test
// Redis. They are skipped when no redis-server binary is installed.
const hasBinary = (() => {
  try {
    execFileSync('redis-server', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });

describe.skipIf(!hasBinary)('redis failure', () => {
  let port = 0;
  let dir = '';
  let server: ChildProcess | undefined;
  const buses: EventLaneBus[] = [];
  const clients: Redis[] = [];

  const startRedis = async (): Promise<void> => {
    server = spawn(
      'redis-server',
      [
        '--port',
        String(port),
        '--bind',
        '127.0.0.1',
        '--dir',
        dir,
        '--appendonly',
        'yes',
        '--appendfsync',
        'always',
        '--save',
        '',
      ],
      { stdio: 'ignore' },
    );
    const probe = new Redis({
      port,
      host: '127.0.0.1',
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    await waitFor(
      async () => {
        try {
          if (probe.status === 'end' || probe.status === 'wait') await probe.connect();
          return (await probe.ping()) === 'PONG';
        } catch {
          return false;
        }
      },
      10000,
      'redis to start',
    );
    probe.disconnect();
  };

  const killRedis = async (): Promise<void> => {
    const child = server;
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    server = undefined;
  };

  const createBus = (consumerName?: string): EventLaneBus => {
    const bus = new EventLaneBus({
      redisUrl: `redis://127.0.0.1:${port}`,
      consumerName,
      blockTimeMs: 200,
      retry: { attempts: 5, backoff: { type: 'fixed', delay: 50 } },
      retryPollMs: 20,
      claimIntervalMs: 100,
      claimIdleMs: 500,
      shutdownTimeoutMs: 2000,
    });
    buses.push(bus);
    return bus;
  };

  beforeAll(async () => {
    port = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'eventlane-redis-'));
    await startRedis();
  });

  afterAll(async () => {
    await Promise.all(buses.map((bus) => bus.close().catch(() => undefined)));
    for (const client of clients) client.disconnect();
    await killRedis();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps delivering after Redis is killed and restarted (nothing lost, duplicates allowed)', async () => {
    const consumer = createBus('notifications');
    const producer = createBus();
    const seen = new Set<number>();
    consumer.on('users', 'user.created', (payload: { n: number }) => {
      seen.add(payload.n);
    });
    await consumer.start();

    for (let n = 0; n < 20; n++) await producer.emit('users', 'user.created', { n });
    await waitFor(() => seen.size === 20, 10000, 'first batch');

    await killRedis();
    // An emit during the outage is queued by ioredis and completes once Redis is back.
    const during = producer.emit('users', 'user.created', { n: 20 });
    await sleep(500);

    await startRedis();
    await during;
    for (let n = 21; n < 40; n++) await producer.emit('users', 'user.created', { n });
    await waitFor(() => [...Array(40).keys()].every((n) => seen.has(n)), 15000, 'all events');
  });

  it('recreates the consumer after the data was flushed (NOGROUP)', async () => {
    const consumer = createBus('flushed');
    const producer = createBus();
    const received: number[] = [];
    consumer.on('orders', (payload: { n: number }) => {
      received.push(payload.n);
    });
    await consumer.start();
    await producer.emit('orders', 'order.created', { n: 1 });
    await waitFor(() => received.includes(1), 5000, 'first event');

    const admin = new Redis({ port, host: '127.0.0.1' });
    clients.push(admin);
    await admin.flushall();
    await sleep(500);

    await waitFor(
      async () => {
        await producer.emit('orders', 'order.created', { n: 2 });
        return received.includes(2);
      },
      10000,
      'event after flush',
    );
  });
});
