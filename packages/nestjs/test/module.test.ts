import { Injectable, Module, Scope } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import {
  type EventLaneBus,
  EventLaneEmitter,
  EventLaneModule,
  type EventMetadata,
  InjectEventLaneBus,
  InjectLaneEmitter,
  OnLaneEvent,
  type TopicEmitter,
} from '../src';
import { sleep, useNestApps, waitFor } from './helpers';

const { rootOptions, createApp, prefix, raw } = useNestApps();

type Seen = { payload: unknown; meta: EventMetadata };

describe('emitting and listening', () => {
  it('a module is a consumer: @OnLaneEvent handles events emitted through @InjectLaneEmitter', async () => {
    const seen: Seen[] = [];

    @Injectable()
    class UsersService {
      constructor(@InjectLaneEmitter('users') readonly users: TopicEmitter) {}
    }

    @Injectable()
    class NotificationsHandler {
      @OnLaneEvent('user.created')
      welcome(payload: unknown, meta: EventMetadata) {
        seen.push({ payload, meta });
      }
    }

    @Module({
      imports: [
        EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users'] }),
      ],
      providers: [UsersService, NotificationsHandler],
    })
    class UsersModule {}

    const app = await createApp({
      imports: [EventLaneModule.forRoot(rootOptions()), UsersModule],
    });
    await app.get(UsersService).users.emit('user.created', { id: 1 });

    await waitFor(() => seen.length === 1);
    expect(seen[0]?.payload).toEqual({ id: 1 });
    expect(seen[0]?.meta).toMatchObject({
      topicName: 'users',
      eventName: 'user.created',
      consumerName: 'notifications',
      attempt: 1,
    });
  });

  it('the plain EventLaneEmitter is injected by class and needs no forFeature', async () => {
    const seen: unknown[] = [];

    @Injectable()
    class Producer {
      constructor(readonly emitter: EventLaneEmitter) {}
    }

    @Injectable()
    class Listener {
      @OnLaneEvent('user.created')
      handle(payload: unknown) {
        seen.push(payload);
      }
    }

    @Module({
      imports: [EventLaneModule.forFeature({ consumerName: 'workers', topicNames: ['users'] })],
      providers: [Listener],
    })
    class ListenerModule {}

    @Module({ providers: [Producer], exports: [Producer] })
    class ProducerModule {}

    const app = await createApp({
      imports: [EventLaneModule.forRoot(rootOptions()), ListenerModule, ProducerModule],
    });
    const { emitter } = app.get(Producer);
    expect(emitter).toBeInstanceOf(EventLaneEmitter);

    await emitter.emit('users', 'user.created', 1);
    await emitter.topic('users').emit('user.created', 2);
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([1, 2]);
  });

  it('two modules are two consumers (fan-out); two handlers in one module are one consumer', async () => {
    const notifications: string[] = [];
    const webhooks: string[] = [];

    @Injectable()
    class NotificationsHandler {
      @OnLaneEvent('user.created')
      email() {
        notifications.push('email');
      }

      @OnLaneEvent('user.created')
      push() {
        notifications.push('push');
      }
    }

    @Injectable()
    class WebhooksHandler {
      @OnLaneEvent('user.created')
      call(_payload: unknown, meta: EventMetadata) {
        webhooks.push(meta.consumerName);
      }
    }

    @Module({
      imports: [
        EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users'] }),
      ],
      providers: [NotificationsHandler],
    })
    class NotificationsModule {}

    @Module({
      imports: [EventLaneModule.forFeature({ consumerName: 'webhooks', topicNames: ['users'] })],
      providers: [WebhooksHandler],
    })
    class WebhooksModule {}

    const app = await createApp({
      imports: [EventLaneModule.forRoot(rootOptions()), NotificationsModule, WebhooksModule],
    });
    await app.get(EventLaneEmitter).emit('users', 'user.created');

    await waitFor(() => notifications.length === 2 && webhooks.length === 1);
    await sleep(100);
    expect(notifications.sort()).toEqual(['email', 'push']);
    expect(webhooks).toEqual(['webhooks']);
  });

  it('listens to a topic that is not the only one, to a whole topic, and to stacked event names', async () => {
    const seen: string[] = [];

    @Injectable()
    class Handler {
      @OnLaneEvent('order.placed', { topicName: 'orders' })
      placed(_p: unknown, meta: EventMetadata) {
        seen.push(`placed:${meta.topicName}`);
      }

      @OnLaneEvent({ topicName: 'orders' })
      audit(_p: unknown, meta: EventMetadata) {
        seen.push(`audit:${meta.eventName}`);
      }

      @OnLaneEvent('user.created', { topicName: 'users' })
      @OnLaneEvent('user.deleted', { topicName: 'users' })
      users(_p: unknown, meta: EventMetadata) {
        seen.push(`users:${meta.eventName}`);
      }
    }

    @Module({
      imports: [
        EventLaneModule.forFeature({ consumerName: 'multi', topicNames: ['users', 'orders'] }),
      ],
      providers: [Handler],
    })
    class MultiModule {}

    const app = await createApp({
      imports: [EventLaneModule.forRoot(rootOptions()), MultiModule],
    });
    const emitter = app.get(EventLaneEmitter);
    await emitter.emit('orders', 'order.placed');
    await emitter.emit('orders', 'order.cancelled');
    await emitter.emit('users', 'user.created');
    await emitter.emit('users', 'user.deleted');
    await emitter.emit('users', 'user.updated'); // nobody listens

    await waitFor(() => seen.length === 5);
    await sleep(100);
    expect(seen.sort()).toEqual([
      'audit:order.cancelled',
      'audit:order.placed',
      'placed:orders',
      'users:user.created',
      'users:user.deleted',
    ]);
  });

  it('handlers keep their dependencies and `this`, and failures are retried by the core', async () => {
    const attempts: number[] = [];

    @Injectable()
    class Counter {
      value = 0;
    }

    @Injectable()
    class Handler {
      constructor(private readonly counter: Counter) {}

      @OnLaneEvent('user.created', { topicName: 'users' })
      handle(_p: unknown, meta: EventMetadata) {
        attempts.push(meta.attempt);
        this.counter.value++;
        if (meta.attempt < 2) throw new Error('first try fails');
      }
    }

    @Module({
      imports: [EventLaneModule.forFeature({ consumerName: 'flaky' })],
      providers: [Counter, Handler],
    })
    class FlakyModule {}

    const app = await createApp({
      imports: [EventLaneModule.forRoot(rootOptions()), FlakyModule],
    });
    await app.get(EventLaneEmitter).emit('users', 'user.created');
    await waitFor(() => attempts.length === 2);
    expect(attempts).toEqual([1, 2]);
    expect(app.get(Counter).value).toBe(2);
  });

  it('applies subscription options and falls back to defaultConsumerName', async () => {
    const seen: string[] = [];

    @Injectable()
    class Handler {
      @OnLaneEvent('user.created', { topicName: 'users' })
      byDefault(_p: unknown, meta: EventMetadata) {
        seen.push(`default:${meta.consumerName}`);
      }

      @OnLaneEvent('user.created', {
        topicName: 'users',
        consumerName: 'special',
        retry: { attempts: 1 },
      })
      special(_p: unknown, meta: EventMetadata) {
        seen.push(`special:${meta.consumerName}`);
      }
    }

    @Module({ providers: [Handler] })
    class NoFeatureModule {}

    const app = await createApp({
      imports: [
        EventLaneModule.forRoot(rootOptions({ defaultConsumerName: 'my-app' })),
        NoFeatureModule,
      ],
    });
    await app.get(EventLaneEmitter).emit('users', 'user.created');
    await waitFor(() => seen.length === 2);
    expect(seen.sort()).toEqual(['default:my-app', 'special:special']);
  });

  it('an emit-only module needs no consumer; the bus can be injected for stats', async () => {
    @Injectable()
    class Service {
      constructor(
        @InjectLaneEmitter('users') readonly users: TopicEmitter,
        @InjectEventLaneBus() readonly bus: EventLaneBus,
      ) {}
    }

    @Module({
      imports: [EventLaneModule.forFeature({ topicNames: ['users'] })],
      providers: [Service],
    })
    class EmitOnlyModule {}

    const app = await createApp({
      imports: [EventLaneModule.forRoot(rootOptions()), EmitOnlyModule],
    });
    const service = app.get(Service);
    await service.users.emit('user.created', { id: 1 });
    expect(await service.bus.stats('users')).toMatchObject({ topicName: 'users', length: 1 });
    expect(await raw.xlen(`${prefix}:users`)).toBe(1);
  });
});

describe('forRootAsync', () => {
  it('builds the options from injected dependencies', async () => {
    const seen: string[] = [];

    @Module({
      providers: [{ provide: 'SETTINGS', useValue: { group: 'from-config' } }],
      exports: ['SETTINGS'],
    })
    class SettingsModule {}

    @Injectable()
    class Handler {
      @OnLaneEvent('user.created', { topicName: 'users' })
      handle(_p: unknown, meta: EventMetadata) {
        seen.push(meta.consumerName);
      }
    }

    @Module({ providers: [Handler] })
    class FeatureModule {}

    const app = await createApp({
      imports: [
        EventLaneModule.forRootAsync({
          imports: [SettingsModule],
          inject: ['SETTINGS'],
          useFactory: (settings: { group: string }) =>
            rootOptions({ defaultConsumerName: settings.group }),
        }),
        FeatureModule,
      ],
    });
    await app.get(EventLaneEmitter).emit('users', 'user.created');
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(['from-config']);
  });
});

describe('startup errors', () => {
  const failing = async (...modules: unknown[]) => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventLaneModule.forRoot(rootOptions()), ...modules] as never[],
    }).compile();
    try {
      await moduleRef.init();
    } finally {
      await moduleRef.close().catch(() => {});
    }
  };

  it('fails clearly when a handler topic is ambiguous or missing', async () => {
    @Injectable()
    class Handler {
      @OnLaneEvent('user.created')
      handle() {}
    }

    @Module({
      imports: [EventLaneModule.forFeature({ consumerName: 'a', topicNames: ['users', 'orders'] })],
      providers: [Handler],
    })
    class SeveralTopics {}

    @Module({
      imports: [EventLaneModule.forFeature({ consumerName: 'a' })],
      providers: [Handler],
    })
    class NoTopic {}

    await expect(failing(SeveralTopics)).rejects.toThrow(
      /Handler\.handle: the module lists several topics \(users, orders\)/,
    );
    await expect(failing(NoTopic)).rejects.toThrow(/Handler\.handle: cannot resolve the topic/);
  });

  it('fails clearly when no consumer can be resolved', async () => {
    @Injectable()
    class Handler {
      @OnLaneEvent('user.created', { topicName: 'users' })
      handle() {}
    }

    @Module({ providers: [Handler] })
    class Orphan {}

    await expect(failing(Orphan)).rejects.toThrow(/Handler\.handle: cannot resolve the consumer/);
  });

  it('rejects a module that imports forFeature with two different consumers', async () => {
    @Injectable()
    class Handler {
      @OnLaneEvent('user.created')
      handle() {}
    }

    @Module({
      imports: [
        EventLaneModule.forFeature({ consumerName: 'a', topicNames: ['users'] }),
        EventLaneModule.forFeature({ consumerName: 'b', topicNames: ['users'] }),
      ],
      providers: [Handler],
    })
    class Confused {}

    await expect(failing(Confused)).rejects.toThrow(/different consumers \(a, b\)/);
  });

  it('rejects handlers on request-scoped providers', async () => {
    @Injectable({ scope: Scope.REQUEST })
    class Scoped {
      @OnLaneEvent('user.created', { topicName: 'users', consumerName: 'x' })
      handle() {}
    }

    @Module({ providers: [Scoped] })
    class ScopedModule {}

    await expect(failing(ScopedModule)).rejects.toThrow(/singleton provider/);
  });

  it('cannot inject an emitter for a topic the module did not list', async () => {
    @Injectable()
    class Service {
      constructor(@InjectLaneEmitter('orders') readonly orders: TopicEmitter) {}
    }

    @Module({
      imports: [EventLaneModule.forFeature({ topicNames: ['users'] })],
      providers: [Service],
    })
    class WrongTopic {}

    await expect(failing(WrongTopic)).rejects.toThrow(
      /EVENT_LANE_EMITTER:orders|resolve dependencies/,
    );
  });
});

describe('shutdown', () => {
  it('lets in-flight handlers finish, then closes the bus', async () => {
    let started = false;
    let finished = false;

    @Injectable()
    class Handler {
      @OnLaneEvent('user.created', { topicName: 'users', consumerName: 'slow' })
      async handle() {
        started = true;
        await sleep(300);
        finished = true;
      }
    }

    @Module({ providers: [Handler] })
    class SlowModule {}

    const app = await createApp({
      imports: [EventLaneModule.forRoot(rootOptions()), SlowModule],
    });
    const emitter = app.get(EventLaneEmitter);
    await emitter.emit('users', 'user.created');
    await waitFor(() => started);

    await app.close();
    expect(finished).toBe(true);
    await expect(emitter.emit('users', 'user.created')).rejects.toThrow(/closed/);
  });
});
