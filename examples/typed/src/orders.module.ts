import { EventLaneEmitter } from '@eventlane/nestjs';
import { Inject, Injectable, Module } from '@nestjs/common';
import type { AppEvents } from './events';

@Injectable()
export class OrdersService {
  // the general emitter, typed with the events of the whole app: the topic is an argument, so it is
  // checked too. It needs no forFeature. `@Inject` is explicit because tsx does not emit the
  // decorator metadata that Nest would use to find the class; with tsc or swc it can be left out.
  constructor(@Inject(EventLaneEmitter) private readonly emitter: EventLaneEmitter<AppEvents>) {}

  place(userId: number, total: number) {
    const orderId = Date.now();
    return this.emitter.emit('orders', 'order.placed', { orderId, userId, total });
  }

  cancel(orderId: number, reason: string) {
    return this.emitter.emit('orders', 'order.cancelled', { orderId, reason });

    // this.emitter.emit('orders', 'user.deleted', { id: 1 });   // error: not an event of "orders"
  }
}

@Module({
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
