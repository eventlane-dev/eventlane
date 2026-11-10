import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { UsersService } from './users.module';

async function main() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();

  const users = app.get(UsersService);
  await app.listen(Number(process.env.PORT ?? 3000));
  console.log('[main] dashboard: http://localhost:3000/admin/events (Ctrl+C to stop)');

  // a user now and then, so there is something to look at
  for (const email of ['ada@example.com', 'grace@example.com', 'linus@example.com']) {
    const user = await users.register(email);
    console.log(`[main] registered user ${user.id}`);
  }
  setInterval(() => users.register(`user${Date.now()}@example.com`), 5000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
