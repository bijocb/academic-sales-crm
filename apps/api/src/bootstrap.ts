import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { AppConfig } from './config';
import { requestContext } from './common/request-context';

/** Shared by main.ts and tests so both run the exact same pipeline. */
export function configureApp(app: INestApplication, config: AppConfig): void {
  const express = app as NestExpressApplication;
  express.set('trust proxy', config.TRUST_PROXY_HOPS);
  express.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const correlationId = (req.headers['x-request-id'] as string) || randomUUID();
    requestContext.run({ correlationId, ip: req.ip, userAgent: req.headers['user-agent'] }, next);
  });
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  if (config.NODE_ENV !== 'production' || config.ENABLE_API_DOCS) {
    const doc = new DocumentBuilder()
      .setTitle('Academic Course Sales CRM API')
      .setVersion('1')
      .addBearerAuth()
      .addCookieAuth('crm_at')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  }
}

export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app, config);
  return app;
}
