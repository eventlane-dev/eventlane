import 'reflect-metadata';
import type { BoardOptions } from '@eventlane/board-api';
import type { EventLaneBus } from '@eventlane/core';
import { EVENT_LANE_BUS } from '@eventlane/nestjs';
import {
  type DynamicModule,
  Inject,
  Injectable,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

export type { BoardOptions } from '@eventlane/board-api';

export interface BoardModuleOptions extends Omit<BoardOptions, 'buses'> {
  /** Where the board is served. Default: `/admin/events`. */
  route?: string;
  /** The bus(es) to show. Default: the bus of `EventLaneModule`. */
  buses?: BoardOptions['buses'];
  /**
   * Express platform only: middleware that runs before the board, for example authentication.
   * (On the Fastify platform use `authorize`, or a hook of your own.)
   */
  // biome-ignore lint/suspicious/noExplicitAny: plain Express middleware, typed by the caller
  middleware?: Array<(req: any, res: any, next: (error?: unknown) => void) => void>;
}

export interface BoardModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  // biome-ignore lint/suspicious/noExplicitAny: injected dependencies are typed by the caller
  useFactory: (...args: any[]) => BoardModuleOptions | Promise<BoardModuleOptions>;
}

const BOARD_OPTIONS = 'EVENT_LANE_BOARD_OPTIONS';

const normalizeRoute = (route: string): string => {
  const trimmed = `/${route.replace(/^\/+|\/+$/g, '')}`;
  return trimmed === '/' ? '' : trimmed;
};

/** Mounts the board on the HTTP application once the module is initialized. */
@Injectable()
class BoardMounter implements OnModuleInit {
  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(BOARD_OPTIONS) private readonly options: BoardModuleOptions,
    @Optional() @Inject(EVENT_LANE_BUS) private readonly bus?: EventLaneBus,
  ) {}

  async onModuleInit(): Promise<void> {
    const { route: configured, buses, middleware, ...rest } = this.options;
    const shown = buses ?? this.bus;
    if (!shown) {
      throw new Error(
        'BoardModule needs a bus: import EventLaneModule.forRoot() (from @eventlane/nestjs) or pass "buses"',
      );
    }
    const adapter = this.host.httpAdapter;
    if (!adapter) {
      throw new Error('BoardModule needs an HTTP application (not an application context)');
    }
    const route = normalizeRoute(configured ?? '/admin/events');
    const type = adapter.getType();
    const instance = adapter.getInstance();

    if (type === 'express') {
      const { createBoard } = await import('@eventlane/board-express').catch(() => {
        throw new Error('BoardModule on Express needs the package @eventlane/board-express');
      });
      instance.use(
        route || '/',
        ...(middleware ?? []),
        createBoard({ buses: shown, ...rest }).router,
      );
    } else if (type === 'fastify') {
      const { createBoard } = await import('@eventlane/board-fastify').catch(() => {
        throw new Error('BoardModule on Fastify needs the package @eventlane/board-fastify');
      });
      await instance.register(createBoard({ buses: shown, ...rest }).plugin, { prefix: route });
    } else {
      throw new Error(`BoardModule supports the Express and Fastify platforms, not "${type}"`);
    }
  }
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static factories
export class BoardModule {
  /**
   * Serves the EventLane board at `route`. It shows the bus of `EventLaneModule` unless you pass
   * `buses`, and is read-only unless you pass `readOnly: false`.
   */
  static forRoot(options: BoardModuleOptions = {}): DynamicModule {
    return {
      module: BoardModule,
      providers: [{ provide: BOARD_OPTIONS, useValue: options }, BoardMounter],
    };
  }

  static forRootAsync(options: BoardModuleAsyncOptions): DynamicModule {
    return {
      module: BoardModule,
      imports: options.imports ?? [],
      providers: [
        { provide: BOARD_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] },
        BoardMounter,
      ],
    };
  }
}
