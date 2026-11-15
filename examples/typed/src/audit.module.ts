import { EventLaneModule, type EventMetadata, OnLaneEvent } from '@eventlane/nestjs';
import { Injectable, Module } from '@nestjs/common';
import type { OrderEvents } from './events';

@Injectable()
export class AuditHandler {
  // without an event name the handler gets every event of the topic: the payload is the union of
  // the payload types, and `meta.eventName` tells them apart
  @OnLaneEvent<OrderEvents>({ topicName: 'orders' })
  async record(payload: OrderEvents[keyof OrderEvents], meta: EventMetadata) {
    console.log(`[audit] ${meta.eventName}`, JSON.stringify(payload));
  }
}

@Module({
  imports: [EventLaneModule.forFeature({ consumerName: 'audit', topicNames: ['orders'] })],
  providers: [AuditHandler],
})
export class AuditModule {}
