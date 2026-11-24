import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type InferEvents, ValidationError } from '../src';
import { useBuses, waitFor } from './helpers';

const { createBus, dlqLength } = useBuses();

const schemas = {
  users: {
    'user.created': z.object({ id: z.number().int(), email: z.string().email().toLowerCase() }),
  },
};

describe('validation with zod', () => {
  it('rejects on emit, applies transforms and dead-letters invalid events on receive', async () => {
    const bus = createBus({ consumerName: 'notifications', schemas });
    const outsider = createBus({ validate: false });
    const received: unknown[] = [];
    bus.on('users', 'user.created', (payload) => {
      received.push(payload);
    });
    await bus.start();

    const error = await bus.emit('users', 'user.created', { id: 1, email: 'nope' }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.issues[0].path).toEqual(['email']);

    await bus.emit('users', 'user.created', { id: 2, email: 'Ada@Example.com' });
    await outsider.emit('users', 'user.created', { id: 'x', email: 'a@b.com' });

    await waitFor(() => received.length === 1);
    expect(received).toEqual([{ id: 2, email: 'ada@example.com' }]);
    await waitFor(async () => (await dlqLength('users')) === 1);
    const [dead] = await bus.dlq.list('users');
    expect(dead?.reason).toBe('validation');
    expect(dead?.error).toMatch(/^invalid payload: id:/);
  });

  it('infers the event map from the schemas', () => {
    type Events = InferEvents<typeof schemas>;
    const event: Events['users']['user.created'] = { id: 1, email: 'a@b.com' };
    expect(event.id).toBe(1);
  });
});
