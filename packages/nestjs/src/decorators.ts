import 'reflect-metadata';
import { Inject } from '@nestjs/common';
import { EVENT_LANE_BUS, getEventLaneEmitterToken, ON_LANE_EVENT_METADATA } from './constants';
import type { HandlerDefinition, OnLaneEventOptions } from './types';

/**
 * Injects a `TopicEmitter` bound to `topicName`. The module must list the topic in
 * `EventLaneModule.forFeature({ topicNames })`.
 */
export const InjectLaneEmitter = (topicName: string): ParameterDecorator & PropertyDecorator =>
  Inject(getEventLaneEmitterToken(topicName));

/** Injects the underlying `EventLaneBus` (for `stats()`, `dlq`, `replay`, ...). */
export const InjectEventLaneBus = (): ParameterDecorator & PropertyDecorator =>
  Inject(EVENT_LANE_BUS);

/**
 * Handles events: `@OnLaneEvent('user.created')` (one event name of the module's topic),
 * `@OnLaneEvent('order.placed', { topicName: 'orders' })` or `@OnLaneEvent({ topicName: 'orders' })`
 * (every event of a topic). The method receives `(payload, meta)`. It can be stacked to listen to
 * several event names.
 */
export function OnLaneEvent(options?: OnLaneEventOptions): MethodDecorator;
export function OnLaneEvent(eventName: string, options?: OnLaneEventOptions): MethodDecorator;
export function OnLaneEvent(
  first?: string | OnLaneEventOptions,
  second?: OnLaneEventOptions,
): MethodDecorator {
  const eventName = typeof first === 'string' ? first : undefined;
  const options = (typeof first === 'string' ? second : first) ?? {};
  if (typeof first === 'string' && first === '') {
    throw new Error('@OnLaneEvent: eventName must be a non-empty string');
  }
  return (_target, propertyKey, descriptor) => {
    const method = descriptor.value;
    if (typeof method !== 'function') {
      throw new Error(`@OnLaneEvent can only decorate methods (${String(propertyKey)})`);
    }
    const existing: HandlerDefinition[] = Reflect.getMetadata(ON_LANE_EVENT_METADATA, method) ?? [];
    Reflect.defineMetadata(ON_LANE_EVENT_METADATA, [...existing, { eventName, options }], method);
  };
}
