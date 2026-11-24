// The events of the app, described once. Nothing here runs: it only tells the type checker which
// topics exist, which events each topic carries and what the payload of each event looks like.

/** The `users` topic: `eventName` to payload type. */
export interface UserEvents {
  'user.registered': { id: number; email: string };
  'user.deleted': { id: number };
}

/** The `orders` topic. */
export interface OrderEvents {
  'order.placed': { orderId: number; userId: number; total: number };
  'order.cancelled': { orderId: number; reason: string };
}

/** The whole app: `topicName` to its events. Used where a bus or a general emitter is typed. */
export interface AppEvents {
  users: UserEvents;
  orders: OrderEvents;
}
