import { EventLaneModule } from '@eventlane/nestjs';
import { Module } from '@nestjs/common';
import { AuditModule } from './audit.module';
import { NotificationsModule } from './notifications.module';
import { OrdersModule } from './orders.module';
import { UsersModule } from './users.module';

@Module({
  imports: [
    EventLaneModule.forRoot({
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6390',
      prefix: 'example-typed',
    }),
    UsersModule,
    OrdersModule,
    NotificationsModule,
    AuditModule,
  ],
})
export class AppModule {}
