import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { setupApp } from './setup-app';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  setupApp(app);

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  const logger = app.get(Logger);
  logger.log(`Inventory API listening on http://localhost:${port}/api/v1`);
  logger.log(`OpenAPI docs at http://localhost:${port}/api/docs`);
}

void bootstrap();
