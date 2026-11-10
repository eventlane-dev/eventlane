import { EventLaneModule, type EventMetadata, OnLaneEvent } from '@eventlane/nestjs';
import { Injectable, Module } from '@nestjs/common';

@Injectable()
export class NotificationsHandler {
  // the topic comes from forFeature below (it lists exactly one)
  @OnLaneEvent('user.created')
  async sendWelcomeEmail(user: { email: string }, meta: EventMetadata) {
    console.log(`[notifications] welcome email to ${user.email} (attempt ${meta.attempt})`);
  }
}

@Module({
  // this module is the consumer "notifications": one instance of it handles each event
  imports: [EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users'] })],
  providers: [NotificationsHandler],
})
export class NotificationsModule {}
