import { describe, expect, it } from 'vitest';
import {
  type EventLaneBus,
  type EventLaneEmitter,
  type EventMetadata,
  OnLaneEvent,
  type TopicEmitter,
} from '../src';

// Checked by `pnpm typecheck`: an unused `@ts-expect-error` fails the build.

interface UserEvents {
  'user.created': { id: number; email: string };
  'user.deleted': { id: number };
}
interface AppEvents {
  users: UserEvents;
}

export class Handlers {
  @OnLaneEvent<UserEvents>('user.created')
  created(payload: UserEvents['user.created'], meta: EventMetadata) {
    void [payload.email, meta];
  }

  @OnLaneEvent<UserEvents>('user.deleted')
  deleted(payload: UserEvents['user.deleted']) {
    void payload.id;
  }

  @OnLaneEvent<UserEvents>('user.deleted')
  noArguments() {}

  @OnLaneEvent<UserEvents>({ topicName: 'users' })
  everything(payload: UserEvents[keyof UserEvents]) {
    void payload;
  }

  // @ts-expect-error unknown event name
  @OnLaneEvent<UserEvents>('user.creatd')
  typo() {}

  // @ts-expect-error the payload is not one of the events' payloads
  @OnLaneEvent<UserEvents>('user.created')
  wrongPayload(payload: { unrelated: string }) {
    void payload;
  }

  // untyped use is unchanged
  @OnLaneEvent('anything')
  free(payload: { whatever: boolean }, meta: EventMetadata) {
    void [payload, meta];
  }
}

export async function emitters(
  users: TopicEmitter<UserEvents>,
  emitter: EventLaneEmitter<AppEvents>,
  untyped: EventLaneEmitter,
  bus: EventLaneBus<AppEvents>,
) {
  await users.emit('user.created', { id: 1, email: 'a@b.com' });
  // @ts-expect-error missing email
  await users.emit('user.created', { id: 1 });

  await emitter.emit('users', 'user.deleted', { id: 1 });
  // @ts-expect-error unknown event name
  await emitter.emit('users', 'user.creatd', { id: 1 });
  await emitter.topic('users').emit('user.deleted', { id: 1 });

  await untyped.emit('anything', 'goes', { a: 1 });
  await untyped.topic('anything').emit('goes');

  await bus.emit('users', 'user.deleted', { id: 1 });
}

describe('typed events', () => {
  it('is checked by the type checker (see the @ts-expect-error lines above)', () => {
    expect(typeof OnLaneEvent).toBe('function');
  });
});
