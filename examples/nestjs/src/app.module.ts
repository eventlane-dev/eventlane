import { BoardModule } from '@eventlane/board-nestjs';
import { EventLaneModule } from '@eventlane/nestjs';
import { Module } from '@nestjs/common';
import { NotificationsModule } from './notifications.module';
import { UsersModule } from './users.module';
import { WebhooksModule } from './webhooks.module';

@Module({
  imports: [
    EventLaneModule.forRoot({
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6390',
      prefix: 'example',
    }),
    // the dashboard, on /admin/events: it shows the bus of EventLaneModule
    BoardModule.forRoot({ readOnly: false }),
    UsersModule,
    NotificationsModule,
    WebhooksModule,
  ],
})
export class AppModule {}
