import { EventLaneModule, InjectLaneEmitter, type TopicEmitter } from '@eventlane/nestjs';
import { Injectable, Module } from '@nestjs/common';
import type { UserEvents } from './events';

@Injectable()
export class UsersService {
  // an emitter bound to "users" and typed with its events: the topic comes from the decorator, the
  // type from the parameter
  constructor(@InjectLaneEmitter('users') private readonly users: TopicEmitter<UserEvents>) {}

  async register(email: string) {
    const user = { id: Date.now(), email };
    await this.users.emit('user.registered', user); // payload checked: { id, email }

    // await this.users.emit('user.registered', { id: user.id });   // error: email is missing
    // await this.users.emit('user.registerd', user);               // error: unknown event name
    return user;
  }

  remove(id: number) {
    return this.users.emit('user.deleted', { id });
  }
}

@Module({
  imports: [EventLaneModule.forFeature({ topicNames: ['users'] })],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
