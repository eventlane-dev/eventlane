import type { EventLaneOptions, SubscribeOptions } from '@eventlane/core';
import type { InjectionToken, ModuleMetadata } from '@nestjs/common';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Options of `EventLaneModule.forRoot`: the core bus options (provide exactly one of `redisUrl` or
 * `redis`), with the bus-wide `consumerName` called `defaultConsumerName`.
 */
export type EventLaneModuleOptions = DistributiveOmit<EventLaneOptions, 'consumerName'> & {
  /** Consumer for handlers whose module does not set its own. */
  defaultConsumerName?: string;
};

export interface EventLaneModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: InjectionToken[];
  // biome-ignore lint/suspicious/noExplicitAny: injected dependencies are typed by the caller
  useFactory: (...args: any[]) => EventLaneModuleOptions | Promise<EventLaneModuleOptions>;
}

export interface EventLaneFeatureOptions {
  /** Makes the module the consumer with this name. Omit for an emit-only module. */
  consumerName?: string;
  /** Topics the module works with: enables `@InjectLaneEmitter(topicName)` and the default topic. */
  topicNames?: string[];
}

export interface OnLaneEventOptions
  extends Pick<SubscribeOptions, 'consumerName' | 'concurrency' | 'dedup' | 'retry' | 'startFrom'> {
  /** Topic to listen to. Default: the only topic of the module's `forFeature`. */
  topicName?: string;
}

/** What `@OnLaneEvent` stores on a method. */
export interface HandlerDefinition {
  eventName: string | undefined;
  options: OnLaneEventOptions;
}

export interface FeatureConfig {
  consumerName: string | undefined;
  topicNames: string[];
}
