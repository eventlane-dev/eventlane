import 'reflect-metadata';
import type { EventLaneBus, Handler } from '@eventlane/core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import type { Module } from '@nestjs/core/injector/module';
import {
  EVENT_LANE_BUS,
  EVENT_LANE_FEATURE,
  EVENT_LANE_OPTIONS,
  ON_LANE_EVENT_METADATA,
} from './constants';
import type { EventLaneModuleOptions, FeatureConfig, HandlerDefinition } from './types';

interface Registration {
  topicName: string;
  eventName: string | undefined;
  handler: Handler;
  options: Record<string, unknown>;
}

/**
 * Finds every `@OnLaneEvent` method at bootstrap, subscribes it on the bus and starts reading.
 * On shutdown it closes the bus: in-flight handlers finish, then the connections close.
 */
@Injectable()
export class EventLaneExplorer implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(EVENT_LANE_BUS) private readonly bus: EventLaneBus,
    @Inject(EVENT_LANE_OPTIONS) private readonly options: EventLaneModuleOptions,
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      for (const r of this.collect()) {
        if (r.eventName === undefined) this.bus.on(r.topicName, r.handler, r.options);
        else this.bus.on(r.topicName, r.eventName, r.handler, r.options);
      }
      await this.bus.start();
    } catch (error) {
      await this.bus.close().catch(() => {});
      throw error;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.bus.close();
  }

  private collect(): Registration[] {
    const registrations: Registration[] = [];
    const wrappers = [...this.discovery.getProviders(), ...this.discovery.getControllers()];
    for (const wrapper of wrappers) {
      const prototype = this.prototypeOf(wrapper);
      if (!prototype) continue;
      for (const methodName of this.methodNames(prototype)) {
        const method = prototype[methodName] as object | undefined;
        const definitions: HandlerDefinition[] | undefined = method
          ? Reflect.getMetadata(ON_LANE_EVENT_METADATA, method)
          : undefined;
        if (!definitions) continue;
        const label = `${prototype.constructor.name}.${methodName}`;
        if (!wrapper.isDependencyTreeStatic() || wrapper.isTransient || !wrapper.instance) {
          throw new Error(
            `${label}: @OnLaneEvent needs a singleton provider; request-scoped and transient providers are not supported`,
          );
        }
        const instance = wrapper.instance as Record<string, (...args: unknown[]) => unknown>;
        const feature = this.featureOf(wrapper.host, label);
        for (const definition of definitions) {
          registrations.push(this.register(instance, methodName, definition, feature, label));
        }
      }
    }
    return registrations;
  }

  private register(
    instance: Record<string, (...args: unknown[]) => unknown>,
    methodName: string,
    { eventName, options }: HandlerDefinition,
    feature: FeatureConfig,
    label: string,
  ): Registration {
    const {
      topicName: explicitTopic,
      consumerName: explicitConsumer,
      ...subscribeOptions
    } = options;

    const topicName =
      explicitTopic ?? (feature.topicNames.length === 1 ? feature.topicNames[0] : undefined);
    if (topicName === undefined) {
      throw new Error(
        feature.topicNames.length === 0
          ? `${label}: cannot resolve the topic. Pass { topicName } to @OnLaneEvent or list the topic in EventLaneModule.forFeature({ topicNames })`
          : `${label}: the module lists several topics (${feature.topicNames.join(', ')}); pass { topicName } to @OnLaneEvent`,
      );
    }

    const consumerName =
      explicitConsumer ?? feature.consumerName ?? this.options.defaultConsumerName;
    if (consumerName === undefined) {
      throw new Error(
        `${label}: cannot resolve the consumer. Set consumerName in EventLaneModule.forFeature, in the @OnLaneEvent options, or defaultConsumerName in EventLaneModule.forRoot`,
      );
    }

    return {
      topicName,
      eventName,
      // resolved at call time, so the method can be replaced (e.g. spied on) after bootstrap
      handler: (payload, meta) => instance[methodName]?.(payload, meta) as Promise<void> | void,
      options: { ...subscribeOptions, consumerName },
    };
  }

  /** The class prototype of a provider, or undefined for values that cannot hold handlers. */
  private prototypeOf(wrapper: InstanceWrapper): Record<string, never> | undefined {
    const candidate = wrapper.instance ?? wrapper.metatype?.prototype;
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const prototype = wrapper.instance ? Object.getPrototypeOf(candidate) : candidate;
    return prototype && prototype !== Object.prototype ? prototype : undefined;
  }

  private methodNames(prototype: object): string[] {
    const scanner = this.scanner as MetadataScanner & {
      getAllMethodNames?: (prototype: object) => string[];
      scanFromPrototype?: (
        instance: null,
        prototype: object,
        callback: (name: string) => string,
      ) => string[];
    };
    // getAllMethodNames exists since Nest 10.1; older versions only have scanFromPrototype
    return (
      scanner.getAllMethodNames?.(prototype) ??
      scanner.scanFromPrototype?.(null, prototype, (name) => name) ??
      []
    );
  }

  /** The `forFeature` settings of the module a provider lives in. */
  private featureOf(host: Module | undefined, label: string): FeatureConfig {
    const configs: FeatureConfig[] = [];
    for (const imported of host?.imports ?? []) {
      const config = imported.providers.get(EVENT_LANE_FEATURE)?.instance as
        | FeatureConfig
        | undefined;
      if (config) configs.push(config);
    }
    const consumerNames = [
      ...new Set(configs.map((c) => c.consumerName).filter((n) => n !== undefined)),
    ];
    if (consumerNames.length > 1) {
      throw new Error(
        `${label}: the module imports EventLaneModule.forFeature with different consumers (${consumerNames.join(', ')}); a module is a single consumer`,
      );
    }
    return {
      consumerName: consumerNames[0],
      topicNames: [...new Set(configs.flatMap((c) => c.topicNames))],
    };
  }
}
