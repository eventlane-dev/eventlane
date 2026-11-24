import { describe, expect, it } from 'vitest';
import { EventLaneError, type InferEvents, type StandardSchemaV1, ValidationError } from '../src';
import { useBuses, waitFor } from './helpers';

const { raw, prefix, createBus, pendingCount, retryCount, dlqLength } = useBuses();

/** A minimal Standard Schema, so the tests do not depend on a validation library. */
function schema<O>(
  check: (value: unknown) => O | { error: string; path?: string[] } | Promise<O>,
): StandardSchemaV1<unknown, O> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: async (value) => {
        const result = await check(value);
        if (typeof result === 'object' && result !== null && 'error' in (result as object)) {
          const failure = result as { error: string; path?: string[] };
          return { issues: [{ message: failure.error, path: failure.path }] };
        }
        return { value: result as O };
      },
    },
  };
}

const user = schema((value) => {
  const v = value as { id?: unknown; role?: unknown };
  if (typeof v?.id !== 'number') return { error: 'must be a number', path: ['id'] };
  return { id: v.id, role: typeof v.role === 'string' ? v.role : 'member' };
});

const schemas = {
  users: {
    'user.created': user,
    'user.logged-out': schema((value) => {
      if (value !== undefined) return { error: 'expected no payload' };
      return undefined;
    }),
  },
};

const streamLength = async (topicName: string) => Number(await raw.xlen(`${prefix}:${topicName}`));

describe('validation on emit', () => {
  it('rejects an invalid payload with a ValidationError and stores nothing', async () => {
    const bus = createBus({ schemas });
    const error = await bus.emit('users', 'user.created', { id: 'x' }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(EventLaneError);
    expect(error.topicName).toBe('users');
    expect(error.eventName).toBe('user.created');
    expect(error.issues).toEqual([{ message: 'must be a number', path: ['id'] }]);
    expect(error.message).toContain('id: must be a number');
    expect(await streamLength('users')).toBe(0);
  });

  it('stores the schema output (defaults and transforms apply)', async () => {
    const bus = createBus({ schemas });
    await bus.emit('users', 'user.created', { id: 1 });
    const [event] = await bus.read('users');
    expect(event?.payload).toEqual({ id: 1, role: 'member' });
  });

  it('does not validate events without a schema', async () => {
    const bus = createBus({ schemas });
    await bus.emit('users', 'user.deleted', { anything: true });
    await bus.emit('other', 'thing.happened', 42);
    expect(await streamLength('users')).toBe(1);
  });

  it('accepts an event without a payload when the schema allows it', async () => {
    const bus = createBus({ schemas });
    await bus.emit('users', 'user.logged-out');
    expect(await streamLength('users')).toBe(1);
  });

  it('treats a schema that throws as an invalid payload', async () => {
    const bus = createBus({
      schemas: {
        users: {
          'user.created': schema(() => {
            throw new Error('boom');
          }),
        },
      },
    });
    const error = await bus.emit('users', 'user.created', {}).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.issues).toEqual([{ message: 'boom' }]);
  });

  it('is skipped with validate "receive" or false', async () => {
    for (const validate of ['receive', false] as const) {
      const bus = createBus({ schemas, validate });
      await bus.emit('users', 'user.created', { id: 'x' });
    }
    expect(await streamLength('users')).toBe(2);
  });
});

describe('validation on receive', () => {
  it('moves an invalid event straight to the dead letters, without retries or handlers', async () => {
    const producer = createBus({ validate: false, schemas });
    const consumer = createBus({ consumerName: 'notifications', schemas });
    const received: unknown[] = [];
    consumer.on('users', 'user.created', (payload) => {
      received.push(payload);
    });
    await consumer.start();

    await producer.emit('users', 'user.created', { id: 'x' });
    await producer.emit('users', 'user.created', { id: 2 });

    await waitFor(() => received.length === 1);
    expect(received).toEqual([{ id: 2, role: 'member' }]); // the handler gets the schema output
    await waitFor(async () => (await dlqLength('users')) === 1);
    const [dead] = await consumer.dlq.list('users');
    expect(dead?.error).toBe('invalid payload: id: must be a number');
    expect(dead?.reason).toBe('validation');
    expect(dead?.attempt).toBe(1);
    expect(dead?.consumerName).toBe('notifications');
    expect(await pendingCount('users', 'notifications')).toBe(0);
    expect(await retryCount('users', 'notifications')).toBe(0);
  });

  it('with onInvalid "drop" acknowledges and skips the event', async () => {
    const producer = createBus({ validate: false });
    const consumer = createBus({ consumerName: 'notifications', schemas, onInvalid: 'drop' });
    const received: unknown[] = [];
    consumer.on('users', (payload) => {
      received.push(payload);
    });
    await consumer.start();

    await producer.emit('users', 'user.created', { id: 'x' });
    await producer.emit('users', 'user.deleted', { id: 3 });

    await waitFor(() => received.length === 1);
    expect(received).toEqual([{ id: 3 }]);
    await waitFor(async () => (await pendingCount('users', 'notifications')) === 0);
    expect(await dlqLength('users')).toBe(0);
  });

  it('matches a stored missing payload against a schema for "no payload"', async () => {
    const bus = createBus({ consumerName: 'notifications', schemas });
    const seen: string[] = [];
    bus.on('users', 'user.logged-out', (_payload, meta) => {
      seen.push(meta.id);
    });
    await bus.start();
    await bus.emit('users', 'user.logged-out');
    await waitFor(() => seen.length === 1);
    expect(await dlqLength('users')).toBe(0);
  });

  it('is skipped with validate "emit" or false', async () => {
    for (const validate of ['emit', false] as const) {
      const producer = createBus({ validate: false });
      const consumer = createBus({ consumerName: `c-${validate}`, schemas, validate });
      const received: unknown[] = [];
      consumer.on('users', 'user.created', (payload) => {
        received.push(payload);
      });
      await consumer.start();
      await producer.emit('users', 'user.created', { id: 'x' });
      await waitFor(() => received.length === 1);
      expect(received).toEqual([{ id: 'x' }]);
    }
    expect(await dlqLength('users')).toBe(0);
  });

  it('an invalid dead letter fails again when re-delivered unchanged', async () => {
    const producer = createBus({ validate: false });
    const consumer = createBus({ consumerName: 'notifications', schemas });
    consumer.on('users', 'user.created', () => {});
    await consumer.start();
    await producer.emit('users', 'user.created', { id: 'x' });
    await waitFor(async () => (await dlqLength('users')) === 1);

    await consumer.dlq.retryMany('users');
    await waitFor(
      async () =>
        (await dlqLength('users')) === 1 && (await retryCount('users', 'notifications')) === 0,
    );
    const [dead] = await consumer.dlq.list('users');
    expect(dead?.error).toMatch(/^invalid payload:/);
    expect(dead?.attempt).toBe(1);
  });
});

describe('without schemas', () => {
  it('validates nothing: any payload is stored and delivered as it was sent', async () => {
    const bus = createBus({ consumerName: 'notifications' });
    const received: unknown[] = [];
    bus.on('users', 'user.created', (payload) => {
      received.push(payload);
    });
    await bus.start();

    await bus.emit('users', 'user.created', { id: 'not-a-number' });
    await bus.emit('users', 'user.created', null);
    await bus.emit('users', 'user.created', 'text');

    await waitFor(() => received.length === 3);
    expect(received).toEqual([{ id: 'not-a-number' }, null, 'text']);
    expect(await dlqLength('users')).toBe(0);
  });

  it('ignores validate and onInvalid when there are no schemas', async () => {
    for (const options of [
      { validate: 'both' },
      { validate: 'receive', onInvalid: 'drop' },
    ] as const) {
      const bus = createBus(options);
      await bus.emit('users', 'user.created', { id: 'x' });
    }
    expect(await streamLength('users')).toBe(2);
  });
});

describe('options', () => {
  it('rejects bad option values and schemas that are not Standard Schemas', () => {
    expect(() => createBus({ validate: 'sometimes' as never })).toThrow(EventLaneError);
    expect(() => createBus({ onInvalid: 'ignore' as never })).toThrow(/onInvalid/);
    expect(() => createBus({ schemas: { users: { 'user.created': {} as never } } })).toThrow(
      /users\.user\.created is not a Standard Schema/,
    );
    expect(() => createBus({ schemas: { 'bad:name': {} as never } })).toThrow(EventLaneError);
  });

  it('infers the event map from the schemas', async () => {
    const typed = createBus({ schemas });
    type Events = InferEvents<typeof schemas>;
    const check: Events['users']['user.created'] = { id: 1, role: 'admin' };
    expect(check.id).toBe(1);
    expect(typed).toBeDefined();
  });
});
