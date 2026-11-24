import { describe, expect, it } from 'vitest';
import { EventLaneBus, type EventMetadata, type StandardSchemaV1, type TopicEmitter } from '../src';

// These checks run in `pnpm typecheck`: `@ts-expect-error` fails the build when a line stops being
// an error, so the test below only proves that the file is part of the suite.

interface UserEvents {
  'user.created': { id: number; email: string };
  'user.deleted': { id: number };
  'user.logged-out': undefined;
}
interface SystemEvents {
  // biome-ignore lint/suspicious/noConfusingVoidType: `void` is a common way to say "no payload"
  'system.ping': void;
}
interface OrderEvents {
  'order.placed': { orderId: number; total: number };
}
interface AppEvents {
  users: UserEvents;
  orders: OrderEvents;
  system: SystemEvents;
}

export async function typedBus(typed: EventLaneBus<AppEvents>, untyped: EventLaneBus) {
  await typed.emit('users', 'user.created', { id: 1, email: 'a@b.com' });
  await typed.emit('users', 'user.created', { id: 1, email: 'a@b.com' }, { idempotencyKey: 'k' });
  await typed.emit('users', 'user.logged-out');
  await typed.emit('system', 'system.ping');
  await typed.emit('orders', 'order.placed', { orderId: 1, total: 9 });

  // @ts-expect-error email is missing
  await typed.emit('users', 'user.created', { id: 1 });
  // @ts-expect-error wrong payload type
  await typed.emit('users', 'user.deleted', { id: 'x' });
  // @ts-expect-error unknown event name
  await typed.emit('users', 'user.creatd', { id: 1 });
  // @ts-expect-error the event belongs to another topic
  await typed.emit('orders', 'user.created', { id: 1, email: 'a' });
  // @ts-expect-error unknown topic
  await typed.emit('nope', 'user.created', {});
  // @ts-expect-error payload is required for this event
  await typed.emit('users', 'user.created');

  typed.on('users', 'user.created', (payload, meta: EventMetadata) => {
    const email: string = payload.email;
    // @ts-expect-error not a field of this payload
    payload.missing;
    void [email, meta];
  });
  typed.on('users', (payload) => {
    // the union of the topic's payloads
    const x: { id: number; email: string } | { id: number } | undefined = payload;
    void x;
  });
  typed.on(['users', 'orders'], 'order.placed', (payload) => {
    void payload.total;
  });
  // @ts-expect-error unknown event name
  typed.on('users', 'user.creatd', () => {});
  // @ts-expect-error unknown topic
  typed.on('nope', () => {});

  const users = typed.emitter('users');
  await users.emit('user.deleted', { id: 1 });
  // @ts-expect-error wrong payload
  await users.emit('user.deleted', { id: 'x' });
  users.on('user.created', (payload) => {
    void payload.email.length;
  });
  // @ts-expect-error unknown event name
  users.on('user.creatd', () => {});

  // untyped code keeps compiling
  await untyped.emit('anything', 'at.all', { whatever: true });
  await untyped.emit('anything', 'no.payload');
  untyped.on('anything', 'at.all', (payload) => payload.whatever);
  untyped.on(['a', 'b'], (payload) => payload);
  const free = untyped.emitter('anything');
  await free.emit('x', 1);
  free.on('x', (payload) => payload.y);
}

export async function typedTopicEmitter(users: TopicEmitter<UserEvents>) {
  await users.emit('user.created', { id: 1, email: 'a@b.com' });
  // @ts-expect-error missing email
  await users.emit('user.created', { id: 1 });
}

export function assignability(typed: EventLaneBus<AppEvents>) {
  // a typed bus can be handed to code that works with any bus (for example the dashboard)
  const any: EventLaneBus = typed;
  return any;
}

describe('typed events', () => {
  it('is checked by the type checker (see the @ts-expect-error lines above)', () => {
    expect(typeof EventLaneBus).toBe('function');
  });
});

export function schemasDoNotNarrowTheEventMap(schema: StandardSchemaV1<unknown, { id: number }>) {
  // without a type argument, `schemas` must not turn into the event map: other names still compile
  const bus = new EventLaneBus({
    redisUrl: 'redis://x',
    schemas: { users: { 'user.created': schema } },
  });
  bus.on('users', 'user.updated', () => {});
  return bus.emit('orders', 'order.placed', { total: 1 });
}

export function schemasMustMatchTheEventMap(schema: StandardSchemaV1<unknown, { id: number }>) {
  return new EventLaneBus<{ users: { 'user.created': { id: string } } }>({
    redisUrl: 'redis://x',
    // @ts-expect-error the schema produces { id: number }, the map says { id: string }
    schemas: { users: { 'user.created': schema } },
  });
}
