import { EventLaneModule, type EventMetadata, OnLaneEvent } from '@eventlane/nestjs';
import { Injectable, Module } from '@nestjs/common';
import type { OrderEvents, UserEvents } from './events';

@Injectable()
export class NotificationsHandler {
  // the type argument lists the events of the topic: the event name is checked and autocompleted,
  // and the method has to take the payload of one of them
  @OnLaneEvent<UserEvents>('user.registered', { topicName: 'users' })
  async welcome(user: UserEvents['user.registered'], meta: EventMetadata) {
    console.log(`[notifications] welcome mail to ${user.email} (attempt ${meta.attempt})`);
  }

  @OnLaneEvent<OrderEvents>('order.placed', { topicName: 'orders' })
  async confirm(order: OrderEvents['order.placed']) {
    console.log(`[notifications] order ${order.orderId} confirmed, total ${order.total}`);
  }

  // @OnLaneEvent<OrderEvents>('order.placd', { topicName: 'orders' })   // error: unknown event name
}

@Module({
  // this module is the consumer "notifications"; it lists two topics, so each handler names its own
  imports: [
    EventLaneModule.forFeature({ consumerName: 'notifications', topicNames: ['users', 'orders'] }),
  ],
  providers: [NotificationsHandler],
})
export class NotificationsModule {}
