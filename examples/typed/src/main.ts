import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { OrdersService } from './orders.module';
import { UsersService } from './users.module';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const users = app.get(UsersService);
  const orders = app.get(OrdersService);

  const user = await users.register('ada@example.com');
  const orderId = await orders.place(user.id, 99);
  console.log(`[main] user ${user.id} placed an order (event ${orderId})`);
  await orders.cancel(user.id, 'changed my mind');

  // let the handlers run, then stop
  setTimeout(() => app.close(), 1500);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
