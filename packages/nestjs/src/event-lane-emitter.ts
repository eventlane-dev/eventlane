import type {
  EmitArgs,
  EventLaneBus,
  EventMap,
  EventName,
  EventPayload,
  TopicEmitter,
  TopicName,
} from '@eventlane/core';

/**
 * General emitter, injectable by class: `constructor(private readonly emitter: EventLaneEmitter)`.
 * Pass the topic on every call, or bind one with `topic()`. The type argument is optional: the
 * events of your app (`topicName` to `eventName` to payload type), as for `EventLaneBus`.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped by default
export class EventLaneEmitter<E extends EventMap<E> = any> {
  constructor(private readonly bus: EventLaneBus<E>) {}

  emit<T extends TopicName<E>, N extends EventName<E, T>>(
    topicName: T,
    eventName: N,
    ...args: EmitArgs<EventPayload<E, T, N>>
  ): Promise<string> {
    return this.bus.emit(topicName, eventName, ...args);
  }

  /** An emitter bound to one topic (the same type `@InjectLaneEmitter` injects). */
  topic<T extends TopicName<E>>(topicName: T): TopicEmitter<E[T]> {
    return this.bus.emitter(topicName);
  }
}
