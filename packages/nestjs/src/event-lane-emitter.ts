import type { EmitOptions, EventLaneBus, TopicEmitter } from '@eventlane/core';

/**
 * General emitter, injectable by class: `constructor(private readonly emitter: EventLaneEmitter)`.
 * Pass the topic on every call, or bind one with `topic()`.
 */
export class EventLaneEmitter {
  constructor(private readonly bus: EventLaneBus) {}

  emit(
    topicName: string,
    eventName: string,
    payload?: unknown,
    options?: EmitOptions,
  ): Promise<string> {
    return this.bus.emit(topicName, eventName, payload, options);
  }

  /** An emitter bound to one topic (the same type `@InjectLaneEmitter` injects). */
  topic(topicName: string): TopicEmitter {
    return this.bus.emitter(topicName);
  }
}
