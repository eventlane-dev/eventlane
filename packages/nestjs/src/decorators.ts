import 'reflect-metadata';
import type { EventMetadata } from '@eventlane/core';
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
 *
 * Optionally pass the events of the topic as the type argument,
 * `@OnLaneEvent<UserEvents>('user.created')`, to check the event name and the payload type of the
 * method (`UserEvents` maps each `eventName` to its payload type).
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped by default
export function OnLaneEvent<Events extends Record<string, any> = any>(
  options?: OnLaneEventOptions,
): LaneMethodDecorator<Events>;
// biome-ignore lint/suspicious/noExplicitAny: untyped by default
export function OnLaneEvent<Events extends Record<string, any> = any>(
  eventName: Extract<keyof Events, string>,
  options?: OnLaneEventOptions,
): LaneMethodDecorator<Events>;
export function OnLaneEvent(
  first?: string | OnLaneEventOptions,
  second?: OnLaneEventOptions,
  // biome-ignore lint/suspicious/noExplicitAny: the implementation is untyped
): LaneMethodDecorator<any> {
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

/**
 * The decorator `@OnLaneEvent` returns: it only accepts a method that takes the payload of one of
 * the events (and optionally `meta`). The parameter is compared loosely (bivariantly) on purpose:
 * a method for one event takes just that event's payload, which is narrower than the union of all.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped by default
type LaneMethodDecorator<Events extends Record<string, any>> = <
  M extends {
    bivarianceHack(payload: Events[Extract<keyof Events, string>], meta: EventMetadata): unknown;
  }['bivarianceHack'],
>(
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<M>,
) => void;
