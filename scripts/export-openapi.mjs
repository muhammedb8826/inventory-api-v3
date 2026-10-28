// Uses the compiled app so Nest's Swagger compiler metadata is included.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { setupApp } = require('../dist/setup-app');
process.env.OPENAPI_EXPORT_PATH ??= 'docs/openapi.json';
const app = await NestFactory.create(AppModule, { bufferLogs:true, logger:false });
try { setupApp(app); await app.init(); console.log(`OpenAPI exported to ${process.env.OPENAPI_EXPORT_PATH}`); }
finally { await app.close(); }
