import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync, mkdirSync } from 'fs';
import helmet from 'helmet';
import { join } from 'path';
import { Logger } from 'nestjs-pino';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

/**
 * Shared HTTP bootstrap used by `main.ts` and e2e.
 * Global prefix: `/api/v1` (breaking-change policy in README).
 */
export function setupApp(app: NestExpressApplication): void {
  app.useLogger(app.get(Logger));

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const uploadsRoot = join(process.cwd(), 'uploads');
  if (!existsSync(uploadsRoot)) {
    mkdirSync(uploadsRoot, { recursive: true });
  }
  app.useStaticAssets(uploadsRoot, { prefix: '/uploads' });

  app.setGlobalPrefix('api/v1');

  const configuredOrigins =
    process.env.CORS_ORIGIN?.split(',')
      .map((o) => o.trim())
      .filter(Boolean) ?? [];
  const corsOrigins =
    configuredOrigins.length > 0
      ? [...new Set([...configuredOrigins, 'http://localhost:3000'])]
      : true;

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Inventory API')
    .setDescription(
      'Stock management API. Breaking changes ship under a new URI version (`/api/v2`); ' +
        '`/api/v1` remains stable. Prefer OpenAPI (`/api/docs`) for contracts; ' +
        '`docs/FRONTEND_API.md` is the human guide.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
  });
}
