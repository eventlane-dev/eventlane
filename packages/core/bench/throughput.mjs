// Throughput and latency benchmark. Run: pnpm --filter @eventlane/core bench (needs a build and Redis).
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { EventLaneBus } from '../dist/index.js';

const url = process.env.REDIS_URL ?? 'redis://localhost:6390';
const N = Number(process.env.BENCH_EVENTS ?? 20000);
const prefix = `bench-${Date.now()}`;
const raw = new Redis(url);
const make = (extra = {}) =>
  new EventLaneBus({
    redisUrl: url,
    prefix,
    batchSize: 100,
    blockTimeMs: 200,
    retry: { attempts: 1 },
    ...extra,
  });
const rate = (n, ms) => Math.round((n / ms) * 1000).toLocaleString('en-US');
const results = [];
const record = (name, n, ms) => {
  results.push(`${name.padEnd(46)} ${rate(n, ms).padStart(9)} events/s`);
  console.log(results.at(-1));
};
const payload = { id: 1, email: 'user@example.com', name: 'Example User', tags: ['a', 'b', 'c'] };

async function emitSequential() {
  const bus = make();
  const n = Math.min(N, 5000);
  const t = performance.now();
  for (let i = 0; i < n; i++) await bus.emit('seq', 'e', payload);
  record('emit, one at a time (awaited)', n, performance.now() - t);
  await bus.close();
}

async function emitConcurrent() {
  const bus = make();
  const t = performance.now();
  await Promise.all(Array.from({ length: N }, () => bus.emit('conc', 'e', payload)));
  record(`emit, ${N} in flight (pipelined)`, N, performance.now() - t);
  await bus.close();
}

async function consume(label, concurrency, work, extra = {}) {
  const topic = `c-${label.replace(/\W/g, '')}-${concurrency}`;
  const producer = make();
  const consumer = make({ consumerName: 'bench' });
  let done = 0;
  let finish;
  const finished = new Promise((r) => (finish = r));
  consumer.on(
    topic,
    async () => {
      if (work) await work();
      if (++done === N) finish();
    },
    { concurrency, startFrom: '0', ...extra },
  );
  // the backlog is written first, then the consumer starts and drains it
  await Promise.all(Array.from({ length: N }, () => producer.emit(topic, 'e', payload)));
  const t = performance.now();
  await consumer.start();
  await finished;
  record(label, N, performance.now() - t);
  await producer.close();
  await consumer.close();
}

async function latency() {
  const producer = make();
  const consumer = make({ consumerName: 'lat' });
  const samples = [];
  let resolveNext;
  consumer.on('lat', (p) => {
    samples.push(performance.now() - p.sent);
    resolveNext();
  });
  await consumer.start();
  for (let i = 0; i < 1000; i++) {
    const next = new Promise((r) => (resolveNext = r));
    await producer.emit('lat', 'e', { sent: performance.now() });
    await next;
  }
  samples.sort((a, b) => a - b);
  const q = (p) => samples[Math.floor(samples.length * p)].toFixed(2);
  const line = `latency emit -> handler (idle bus): p50 ${q(0.5)} ms, p95 ${q(0.95)} ms, p99 ${q(0.99)} ms`;
  results.push(line);
  console.log(line);
  await producer.close();
  await consumer.close();
}

const info = await raw.info('server');
console.log(
  `Node ${process.version}, Redis ${/redis_version:(\S+)/.exec(info)?.[1]}, ${hostname()}, ${N} events\n`,
);
await emitSequential();
await emitConcurrent();
await consume('consume, concurrency 1, no work', 1, undefined);
await consume('consume, concurrency 10, no work', 10, undefined);
await consume('consume, concurrency 50, no work', 50, undefined);
await consume(
  'consume, concurrency 50, 5 ms of async work',
  50,
  () => new Promise((r) => setTimeout(r, 5)),
);
await consume('consume, concurrency 10, dedup on', 10, undefined, { dedup: true });
await latency();
const keys = await raw.keys(`${prefix}:*`);
if (keys.length) await raw.del(...keys);
raw.disconnect();
