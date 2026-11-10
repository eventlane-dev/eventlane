import { EventLaneModule, InjectLaneEmitter, type TopicEmitter } from '@eventlane/nestjs';
import { Injectable, Module } from '@nestjs/common';

@Injectable()
export class UsersService {
  // an emitter bound to the "users" topic: only the event name and the payload are passed
  constructor(@InjectLaneEmitter('users') private readonly users: TopicEmitter) {}

  async register(email: string) {
    const user = { id: Date.now(), email };
    // ...save the user, then announce it
    await this.users.emit('user.created', user, { idempotencyKey: `user-${user.id}` });
    return user;
  }
}

@Module({
  // this module only emits to "users": no consumerName
  imports: [EventLaneModule.forFeature({ topicNames: ['users'] })],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
