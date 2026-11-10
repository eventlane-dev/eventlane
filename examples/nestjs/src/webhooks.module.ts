import { EventLaneModule, type EventMetadata, OnLaneEvent } from '@eventlane/nestjs';
import { Injectable, Module } from '@nestjs/common';

@Injectable()
export class WebhooksHandler {
  // every event of the "users" topic, whatever its name
  @OnLaneEvent({ topicName: 'users' })
  async call(payload: unknown, meta: EventMetadata) {
    console.log(`[webhooks] POST ${meta.eventName}`, JSON.stringify(payload));
  }
}

@Module({
  // a second consumer of the same topic: it gets its own copy of every event
  imports: [EventLaneModule.forFeature({ consumerName: 'webhooks', topicNames: ['users'] })],
  providers: [WebhooksHandler],
})
export class WebhooksModule {}
