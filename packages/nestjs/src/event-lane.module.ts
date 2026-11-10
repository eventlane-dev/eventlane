import { EventLaneBus, type EventLaneOptions } from '@eventlane/core';
import { type DynamicModule, Logger, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import {
  EVENT_LANE_BUS,
  EVENT_LANE_FEATURE,
  EVENT_LANE_OPTIONS,
  getEventLaneEmitterToken,
} from './constants';
import { EventLaneEmitter } from './event-lane-emitter';
import { EventLaneExplorer } from './explorer';
import type {
  EventLaneFeatureOptions,
  EventLaneModuleAsyncOptions,
  EventLaneModuleOptions,
  FeatureConfig,
} from './types';

/** Carries the settings of one `forFeature` call; the explorer reads them from the importer. */
@Module({})
export class EventLaneFeatureModule {}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static factories
export class EventLaneModule {
  /** Once, in the root module. Global: other modules only need `forFeature`. */
  static forRoot(options: EventLaneModuleOptions): DynamicModule {
    return EventLaneModule.build([{ provide: EVENT_LANE_OPTIONS, useValue: options }], []);
  }

  static forRootAsync(options: EventLaneModuleAsyncOptions): DynamicModule {
    return EventLaneModule.build(
      [
        {
          provide: EVENT_LANE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
      ],
      options.imports ?? [],
    );
  }

  /**
   * In every module that listens (`consumerName`) or injects topic emitters (`topicNames`).
   */
  static forFeature(options: EventLaneFeatureOptions = {}): DynamicModule {
    const topicNames = [...new Set(options.topicNames ?? [])];
    const config: FeatureConfig = { consumerName: options.consumerName, topicNames };
    const emitters: Provider[] = topicNames.map((topicName) => ({
      provide: getEventLaneEmitterToken(topicName),
      useFactory: (bus: EventLaneBus) => bus.emitter(topicName),
      inject: [EVENT_LANE_BUS],
    }));
    return {
      module: EventLaneFeatureModule,
      providers: [{ provide: EVENT_LANE_FEATURE, useValue: config }, ...emitters],
      exports: topicNames.map(getEventLaneEmitterToken),
    };
  }

  private static build(
    optionsProviders: Provider[],
    imports: NonNullable<EventLaneModuleAsyncOptions['imports']>,
  ): DynamicModule {
    return {
      module: EventLaneModule,
      global: true,
      imports: [DiscoveryModule, ...imports],
      providers: [
        ...optionsProviders,
        {
          provide: EVENT_LANE_BUS,
          useFactory: (options: EventLaneModuleOptions) => {
            const { defaultConsumerName, ...rest } = options;
            const nestLogger = new Logger('EventLane');
            return new EventLaneBus({
              logger: {
                debug: () => undefined,
                info: (message: string) => nestLogger.log(message),
                warn: (message: string) => nestLogger.warn(message),
                error: (message: string) => nestLogger.error(message),
              },
              ...rest,
              consumerName: defaultConsumerName,
            } as EventLaneOptions);
          },
          inject: [EVENT_LANE_OPTIONS],
        },
        {
          provide: EventLaneEmitter,
          useFactory: (bus: EventLaneBus) => new EventLaneEmitter(bus),
          inject: [EVENT_LANE_BUS],
        },
        EventLaneExplorer,
      ],
      exports: [EVENT_LANE_BUS, EventLaneEmitter],
    };
  }
}
